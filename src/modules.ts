import { mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  atomicJson,
  checkedFile,
  copyFiles,
  hash,
  readJson,
  relativeName,
  snapshotFiles,
  withLock,
} from "./files.js";
import {
  allows,
  assertFiles,
  commit,
  dirty,
  exists,
  git,
  type MigrationOptions,
} from "./migrate.js";
import {
  candidateFiles,
  fingerprint,
  loadTask,
  prepareTask,
} from "./workspace.js";
import { currentVerification, VERIFIER_VERSION, verifyPort } from "./verify.js";
import { executeGo, succeeded, testResults } from "./process.js";
import { verificationDiagnostics } from "./diagnostics.js";

type File = { name: string; data: Buffer };
type Entry = { name: string; sha256: string };
type Module = { id: string; dependsOn: string[]; batches: string[] };
type Batch = {
  id: string;
  module: string;
  dependsOn: string[];
  sources: string[];
  references: string[];
  outputs: string[];
  behaviors: string[];
  acceptance: string[];
};
type Plan = {
  version: 2;
  source: string;
  revision: string;
  analysisSha256: string;
  modules: Module[];
  batches: Batch[];
};
type Step = {
  id: string;
  sources: string[];
  goal: string;
  contract: string;
  judge: string;
  outputs: string[];
  tests: string[];
  race?: boolean;
  assets?: { source: string; target: string; sha256: string }[];
};
type BatchConfig = {
  status: "ready" | "partial" | "planned";
  reason?: string;
  steps: Step[];
};
type Workflow = {
  version: 2;
  project: string;
  runs: string;
  bootstrap: string[];
  startPolicy?: "all-prepared" | "available-steps";
  /** Separate journal for an additive migration; the project lock is shared. */
  journal?: string;
  /** Existing product files, frozen at a reviewed commit, injected read-only. */
  baseline?: { commit: string; files: Entry[] };
  batches: Record<string, BatchConfig>;
};
type Item = {
  key: string;
  module: string;
  batch: string;
  spec: Step;
  seal: string;
  contract: string;
  judge: File[];
  assets: File[];
};
type Done = {
  key: string;
  seal: string;
  task: string;
  fingerprint: string;
  files: Entry[];
};
type Pending = {
  module: string;
  base: string;
  files: Entry[];
  message: string;
  task: string;
  fingerprint: string;
  staging: string;
};
type State = {
  version: 2;
  identity: string;
  steps: Done[];
  modules: { id: string; commit: string; files: Entry[] }[];
  pending?: Pending;
  attempts: Record<string, number>;
};
const ID = /^[a-zA-Z0-9_-]+$/;
const entries = (files: File[]) =>
  files.map((f) => ({ name: f.name, sha256: hash(f.data) }));
const bigSnapshot = (root: string) => snapshotFiles(root);

function graph(items: { id: string; dependsOn: string[] }[]) {
  const nodes = new Map(items.map((i) => [i.id, i]));
  if (nodes.size !== items.length || items.some((i) => !ID.test(i.id)))
    throw Error("Duplicate or invalid ID");
  const done = new Set<string>(),
    visiting = new Set<string>();
  function visit(id: string) {
    if (!nodes.has(id)) throw Error(`Unknown dependency: ${id}`);
    if (done.has(id)) return;
    if (visiting.has(id)) throw Error(`Dependency cycle: ${id}`);
    visiting.add(id);
    for (const dep of nodes.get(id)!.dependsOn) visit(dep);
    visiting.delete(id);
    done.add(id);
  }
  for (const id of nodes.keys()) visit(id);
}
function outputName(name: string) {
  relativeName(name);
  if (
    !/\.(go|json|txt|md|yaml|yml|csv)$/.test(name) ||
    name
      .split("/")
      .some(
        (p) =>
          p.startsWith(".") ||
          p.startsWith("portsmith_judge") ||
          p.startsWith("port_oracle"),
      ) ||
    ["go.mod", "go.sum", "LICENSE"].includes(name) ||
    name.startsWith("migration/")
  )
    throw Error(`Module output is not allowed: ${name}`);
}
export async function inspectModules(planInput: string) {
  const root = await realpath(planInput);
  const p = await readJson<Plan>(root, "plan.json"),
    w = await readJson<Workflow>(root, "workflow.json");
  if (
    p.version !== 2 ||
    w.version !== 2 ||
    !Array.isArray(p.modules) ||
    !Array.isArray(p.batches) ||
    !w.batches ||
    !Array.isArray(w.bootstrap)
  )
    throw Error(
      "Incomplete module workflow: v2 modules/batches and execution steps are required",
    );
  if (
    w.startPolicy !== undefined &&
    !["all-prepared", "available-steps"].includes(w.startPolicy)
  )
    throw Error("startPolicy must be all-prepared or available-steps");
  graph(p.modules);
  graph(p.batches);
  const project = await realpath(path.resolve(root, w.project));
  if ((await git(project, ["rev-parse", "--show-toplevel"])) !== project)
    throw Error("project must be the target Git root");
  relativeName(w.runs);
  if (!w.runs.startsWith(".portsmith/"))
    throw Error("Module task directories must be under .portsmith");
  for (const n of w.bootstrap) {
    relativeName(n);
    if (
      n.split("/").some((s) => s.startsWith(".git") && s !== ".gitignore") ||
      n.startsWith(".env") ||
      n.startsWith(".portsmith")
    )
      throw Error("bootstrap must not include credentials or internal state");
  }
  const source = await realpath(path.resolve(project, p.source));
  const raw = await readFile(await checkedFile(root, "analysis.json"));
  if (hash(raw) !== p.analysisSha256) throw Error("Analysis snapshot changed");
  const analysis = JSON.parse(raw.toString()) as {
    files: { path: string; sha256: string }[];
    configs: { path: string; sha256: string }[];
  };
  const known = new Map(analysis.files.map((f) => [f.path, f.sha256]));
  for (const c of analysis.configs)
    if (hash(await readFile(await checkedFile(source, c.path))) !== c.sha256)
      throw Error(`Source configuration changed: ${c.path}`);
  const rules = await readFile(await checkedFile(root, "RULEBOOK.md"));
  const mod = await readFile(await checkedFile(project, "go.mod"));
  const sum = (await exists(path.join(project, "go.sum")))
    ? await readFile(await checkedFile(project, "go.sum"))
    : undefined;
  await checkedFile(root, "go.mod"); // keep fixture trees out of root go test ./...
  const batches = new Map(p.batches.map((b) => [b.id, b]));
  if (Object.keys(w.batches).some((id) => !batches.has(id)))
    throw Error("Workflow contains a batch not listed in the plan");
  const listed = p.modules.flatMap((m) => m.batches);
  if (
    new Set(listed).size !== p.batches.length ||
    listed.length !== p.batches.length ||
    listed.some((id) => !batches.has(id))
  )
    throw Error("Batch ownership is incomplete");
  const items: Item[] = [],
    outputOwners = new Map<string, string>(),
    assetOwners = new Set<string>(),
    judgeOwners = new Set<string>();
  for (const m of p.modules)
    for (const id of m.batches) {
      const b = batches.get(id)!;
      if (
        b.module !== m.id ||
        b.dependsOn.some((d) => batches.get(d)?.module !== m.id)
      )
        throw Error(`Invalid batch ownership/dependencies: ${id}`);
      const cfg = w.batches[id];
      if (
        !cfg ||
        !["ready", "partial", "planned"].includes(cfg.status) ||
        !Array.isArray(cfg.steps) ||
        (cfg.status !== "ready" && !cfg.reason)
      )
        throw Error(`Missing batch preparation status: ${id}`);
      if (
        (cfg.status === "planned" && cfg.steps.length) ||
        (cfg.status === "ready" && !cfg.steps.length)
      )
        throw Error(`Batch status does not match its steps: ${id}`);
      const ids = new Set<string>();
      for (const s of cfg.steps) {
        if (
          !ID.test(s.id) ||
          ids.has(s.id) ||
          !s.goal?.trim() ||
          !s.sources?.length ||
          !s.outputs?.length ||
          !s.tests?.length
        )
          throw Error(`Invalid step configuration: ${id}/${s.id}`);
        ids.add(s.id);
        const sources = [];
        for (const name of s.sources) {
          if (![...b.sources, ...b.references].includes(name))
            throw Error(`Source is not part of the batch: ${id}/${name}`);
          const data = await readFile(await checkedFile(source, name));
          if (!known.has(name) || known.get(name) !== hash(data))
            throw Error(`Source changed after analysis: ${name}`);
          sources.push({ name, sha256: hash(data) });
        }
        const contract = await readFile(await checkedFile(root, s.contract));
        const assets: File[] = [];
        for (const a of s.assets ?? []) {
          outputName(a.target);
          if (
            !b.outputs.includes(a.target) ||
            outputOwners.has(a.target) ||
            s.outputs.includes(a.target)
          )
            throw Error(
              `Static asset target conflicts or is not registered: ${a.target}`,
            );
          const data = await readFile(await checkedFile(root, a.source));
          if (hash(data) !== a.sha256)
            throw Error(
              `Static asset changed or exceeds a configured limit: ${a.source}`,
            );
          assets.push({ name: a.target, data });
          outputOwners.set(a.target, m.id);
          assetOwners.add(a.target);
        }
        const judge = await bigSnapshot(path.join(root, relativeName(s.judge)));
        const testText = judge
          .filter((f) => f.name.endsWith("_test.go"))
          .map((f) => f.data.toString())
          .join("\n");
        if (
          new Set(s.tests).size !== s.tests.length ||
          !s.tests.every(
            (n) =>
              /^TestPortsmithJudge\w+$/.test(n) &&
              new RegExp(`func\\s+${n}\\s*\\(`).test(testText),
          )
        )
          throw Error(`Missing independent tests: ${id}/${s.id}`);
        if (
          !s.outputs.some((n) => n.endsWith("_test.go")) ||
          !s.outputs.some((n) => n.endsWith(".go") && !n.endsWith("_test.go"))
        )
          throw Error(
            `Step requires implementation and candidate tests: ${id}/${s.id}`,
          );
        for (const n of s.outputs) {
          outputName(n);
          if (assetOwners.has(n))
            throw Error(
              `Static assets cannot be declared as writable outputs: ${n}`,
            );
          if (
            !b.outputs.includes(n) &&
            !(
              n.endsWith("_test.go") &&
              b.outputs.some(
                (o) => path.posix.dirname(o) === path.posix.dirname(n),
              )
            )
          )
            throw Error(`Output is not listed in the plan: ${id}/${n}`);
          if (outputOwners.has(n) && outputOwners.get(n) !== m.id)
            throw Error(`Module output conflict: ${n}`);
          outputOwners.set(n, m.id);
        }
        for (const f of judge) {
          relativeName(f.name);
          if (
            (!f.name.endsWith("_test.go") && !f.name.includes("/testdata/")) ||
            judgeOwners.has(f.name)
          )
            throw Error(
              `Conflicting or invalid independent test path: ${f.name}`,
            );
          judgeOwners.add(f.name);
        }
        const key = `${m.id}/${id}/${s.id}`;
        items.push({
          key,
          module: m.id,
          batch: id,
          spec: s,
          contract: contract.toString(),
          judge,
          assets,
          seal: hash(
            JSON.stringify({
              key,
              spec: s,
              sources,
              contract: hash(contract),
              judge: entries(judge),
              assets: entries(assets),
              rules: hash(rules),
              verifier: VERIFIER_VERSION,
            }),
          ),
        });
      }
      if (
        cfg.status === "ready" &&
        b.outputs.some(
          (n) =>
            !cfg.steps.some(
              (s) =>
                s.outputs.includes(n) || s.assets?.some((a) => a.target === n),
            ),
        )
      )
        throw Error(`Ready batch does not cover all outputs: ${id}`);
    }
  for (const n of judgeOwners)
    if (outputOwners.has(n))
      throw Error(`Candidate can overwrite an independent test: ${n}`);
  if (w.journal !== undefined) {
    relativeName(w.journal);
    if (
      !/^\.portsmith\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.json$/.test(
        w.journal,
      )
    )
      throw Error("journal must be a JSON file under .portsmith");
  }
  const baseline: File[] = [];
  if (w.baseline) {
    if (!/^[a-f0-9]{40}$/.test(w.baseline.commit) || !w.baseline.files?.length)
      throw Error(
        "baseline requires a full commit and non-empty file manifest",
      );
    if (!w.journal || w.journal === ".portsmith/modules.json")
      throw Error("an additive baseline requires a separate journal");
    await git(project, [
      "merge-base",
      "--is-ancestor",
      w.baseline.commit,
      "HEAD",
    ]);
    const seen = new Set<string>();
    // ls-tree verifies bytes against Git objects without text decoding.
    const tree = new Map(
      (await git(project, ["ls-tree", "-r", w.baseline.commit]))
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [meta, name] = line.split("\t");
          return [name!, meta!.split(" ")] as const;
        }),
    );
    for (const f of w.baseline.files) {
      relativeName(f.name);
      if (
        !/^[a-f0-9]{64}$/.test(f.sha256) ||
        seen.has(f.name) ||
        !/^(packages|internal|cmd)\//.test(f.name) ||
        f.name.split("/").some((n) => n.startsWith(".")) ||
        outputOwners.has(f.name) ||
        judgeOwners.has(f.name)
      )
        throw Error(`invalid or overlapping baseline file: ${f.name}`);
      seen.add(f.name);
      const data = await readFile(await checkedFile(project, f.name));
      if (
        f.name
          .split("/")
          .some(
            (n) =>
              n.startsWith("portsmith_judge") || n.startsWith("port_oracle"),
          ) ||
        (f.name.endsWith("_test.go") &&
          /^\s*func\s+TestPortsmithJudge\w*\s*\(/m.test(data.toString()))
      )
        throw Error(
          `baseline contains a reserved judge; keep it in project integration tests: ${f.name}`,
        );
      const object = tree.get(f.name);
      const blob = createHash("sha1")
        .update(`blob ${data.length}\0`)
        .update(data)
        .digest("hex");
      if (
        !object ||
        object[0] !== "100644" ||
        object[2] !== blob ||
        hash(data) !== f.sha256
      )
        throw Error(`baseline changed: ${f.name}`);
      baseline.push({ name: f.name, data });
    }
  }
  const names = items.flatMap((s) => s.spec.tests);
  if (new Set(names).size !== names.length)
    throw Error("Independent test names must be unique across steps");
  if (
    w.bootstrap.some((n) =>
      [...outputOwners.keys()].some((o) => allows(o, [n])),
    )
  )
    throw Error("bootstrap must not include product outputs");
  const identity = hash(
    JSON.stringify({
      revision: p.revision,
      source,
      modules: p.modules.map((m) => ({
        id: m.id,
        dependsOn: m.dependsOn,
        batches: m.batches,
      })),
      batches: p.batches.map((b) => ({
        id: b.id,
        module: b.module,
        dependsOn: b.dependsOn,
      })),
      runs: w.runs,
      ...(w.journal ? { journal: w.journal } : {}),
      ...(w.baseline ? { baseline: w.baseline } : {}),
      rules: hash(rules),
      license: hash(await readFile(await checkedFile(source, "LICENSE"))),
    }),
  );
  return { root, p, w, project, source, mod, sum, items, identity, baseline };
}

function nextWork(i: Awaited<ReturnType<typeof inspectModules>>, state: State) {
  const done = new Set(state.steps.map((s) => s.key)),
    accepted = new Set(state.modules.map((m) => m.id));
  const module = i.p.modules.find(
    (m) => !accepted.has(m.id) && m.dependsOn.every((d) => accepted.has(d)),
  );
  if (!module)
    return {
      module: undefined,
      next: undefined,
      blocked: [] as { batch: string; reason: string }[],
      complete: true,
    };
  const batchDone = (id: string) =>
    i.w.batches[id].status === "ready" &&
    i.items.filter((s) => s.batch === id).every((s) => done.has(s.key));
  const next = module.batches
    .flatMap((id) => i.items.filter((s) => s.batch === id))
    .find(
      (s) =>
        !done.has(s.key) &&
        i.p.batches.find((b) => b.id === s.batch)!.dependsOn.every(batchDone),
    );
  const blocked = module.batches
    .filter((id) => i.w.batches[id].status !== "ready")
    .map((id) => ({ batch: id, reason: i.w.batches[id].reason! }));
  return { module, next, blocked, complete: module.batches.every(batchDone) };
}
async function validDone(
  i: Awaited<ReturnType<typeof inspectModules>>,
  state: State,
) {
  if (state.version !== 2 || state.identity !== i.identity)
    throw Error(
      "Source, module structure or rules changed; replan instead of reusing progress",
    );
  const verified = new Set(state.steps.map((s) => s.key));
  if (
    verified.size !== state.steps.length ||
    new Set(state.modules.map((m) => m.id)).size !== state.modules.length
  )
    throw Error("Duplicate module progress records");
  for (const d of state.steps) {
    const item = i.items.find((s) => s.key === d.key);
    if (!item || item.seal !== d.seal)
      throw Error(
        `Completed step source, contract or acceptance changed: ${d.key}`,
      );
    const siblings = i.items.filter((s) => s.batch === item.batch);
    if (
      siblings
        .slice(
          0,
          siblings.findIndex((s) => s.key === d.key),
        )
        .some((s) => !verified.has(s.key))
    )
      throw Error(`Cannot insert a new step before a completed step: ${d.key}`);
    const batch = i.p.batches.find((b) => b.id === item.batch)!;
    if (
      batch.dependsOn.some(
        (id) =>
          i.w.batches[id].status !== "ready" ||
          i.items.some((s) => s.batch === id && !verified.has(s.key)),
      )
    )
      throw Error(
        `A prerequisite batch of a completed step was extended: ${d.key}`,
      );
    const root = path.join(i.project, d.task);
    const v = await currentVerification(root);
    if (
      !v?.current ||
      v.report.status !== "behavior_verified" ||
      v.report.fingerprint !== d.fingerprint
    )
      throw Error(`Completed step verification is no longer valid: ${d.key}`);
    await assertFiles(path.join(root, "candidate"), d.files);
  }
  for (const m of state.modules) {
    if (!i.p.modules.some((x) => x.id === m.id))
      throw Error(`Unknown committed module: ${m.id}`);
    if (
      i.p.modules
        .find((x) => x.id === m.id)!
        .batches.some((b) => i.w.batches[b].status !== "ready") ||
      i.items.some((s) => s.module === m.id && !verified.has(s.key))
    )
      throw Error(`Committed module execution scope changed: ${m.id}`);
    await git(i.project, ["merge-base", "--is-ancestor", m.commit, "HEAD"]);
    await assertFiles(i.project, m.files);
  }
}

export async function migrateModules(options: MigrationOptions) {
  const i = await inspectModules(options.plan);
  const control = path.join(i.project, ".portsmith"),
    journal = path.join(i.project, i.w.journal ?? ".portsmith/modules.json");
  const fresh = (): State => ({
    version: 2,
    identity: i.identity,
    steps: [],
    modules: [],
    attempts: {},
  });
  const load = async () =>
    (await exists(journal))
      ? readJson<State>(i.project, i.w.journal ?? ".portsmith/modules.json")
      : fresh();
  const startPolicy = i.w.startPolicy ?? "all-prepared";
  const blocked = i.p.batches
    .filter((b) => i.w.batches[b.id].status !== "ready")
    .map((b) => ({
      module: b.module,
      batch: b.id,
      reason: i.w.batches[b.id].reason!,
    }));
  const preparation = {
    policy: startPolicy,
    ready: blocked.length === 0,
    readyBatches: i.p.batches.length - blocked.length,
    totalBatches: i.p.batches.length,
    modules: i.p.modules.map((m) => ({
      id: m.id,
      readyBatches: m.batches.filter((b) => i.w.batches[b].status === "ready")
        .length,
      totalBatches: m.batches.length,
    })),
  };
  // A ready first step does not mean a complete migration can start. Check the
  // whole plan before any task directory, bootstrap commit or model call.
  if (options.check || (blocked.length && startPolicy === "all-prepared")) {
    const state = await load();
    await validDone(i, state);
    const n = nextWork(i, state);
    const runnable =
      (!blocked.length || startPolicy === "available-steps") &&
      (!!n.next || (!!n.module && n.complete));
    return {
      status: !n.module
        ? "complete"
        : runnable
          ? !blocked.length
            ? "ready"
            : "partially-ready"
          : "needs-preparation",
      canStart: runnable,
      next: runnable ? n.next?.key : undefined,
      preparation,
      modules: i.p.modules.map((m) => ({
        id: m.id,
        status: state.modules.some((x) => x.id === m.id)
          ? "accepted"
          : "pending",
      })),
      preparedSteps: i.items.length,
      verifiedSteps: state.steps.length,
      blocked,
      note: !n.module
        ? "All planned modules passed acceptance and were committed. No generation is needed."
        : blocked.length && startPolicy === "all-prepared"
          ? "The complete plan is not prepared. No model calls, task creation or commits will occur. Preparing the first step does not unblock missing materials; prepare all batches first."
          : "Preparation status does not mean the Go module is implemented. Use --commit to call the model and save progress.",
    };
  }
  if (!options.commit)
    throw Error(
      "Module migration requires --commit, allowing preparation and whole-module commits; it does not push",
    );
  const attempts = options.maxAttempts ?? 0,
    limit = options.maxUnits ?? i.p.modules.length;
  if (
    !Number.isInteger(attempts) ||
    attempts < 0 ||
    !Number.isInteger(limit) ||
    limit < 1
  )
    throw Error(
      "max-attempts must be non-negative (0 means unlimited); max-units must be positive (v2 counts modules)",
    );
  await mkdir(control, { recursive: true });
  await git(i.project, [
    "check-ignore",
    i.w.journal ?? ".portsmith/modules.json",
  ]);
  const log = options.onProgress ?? (() => {});
  const cancel = () => {
    if (options.signal?.aborted)
      throw Error(
        "Migration cancelled; module candidate and progress preserved",
      );
  };
  return withLock(control, async () => {
    await mkdir(path.dirname(journal), { recursive: true });
    const state = await load();
    const save = () => atomicJson(journal, state);
    const clean = async () => {
      const d = await dirty(i.project);
      if (d.length)
        throw Error(
          `Target working tree has unrelated changes: ${d.join(", ")}`,
        );
    };
    const unchanged = async () => {
      const now = await inspectModules(i.root);
      if (
        now.identity !== i.identity ||
        JSON.stringify(now.p) !== JSON.stringify(i.p) ||
        JSON.stringify(now.w) !== JSON.stringify(i.w) ||
        JSON.stringify(now.items.map((s) => [s.key, s.seal])) !==
          JSON.stringify(i.items.map((s) => [s.key, s.seal])) ||
        hash(now.mod) !== hash(i.mod) ||
        (now.sum && hash(now.sum)) !== (i.sum && hash(i.sum))
      )
        throw Error(
          "Migration materials changed during execution; stopped. Review materials before rerunning",
        );
    };
    const recover = async () => {
      const p = state.pending;
      if (!p) return;
      const staged = await snapshotFiles(path.join(i.project, p.staging));
      if (
        JSON.stringify(
          entries(staged).sort((a, b) => a.name.localeCompare(b.name)),
        ) !==
        JSON.stringify(
          [...p.files].sort((a, b) => a.name.localeCompare(b.name)),
        )
      )
        throw Error("Module integration staging was modified");
      const head = await git(i.project, ["rev-parse", "HEAD"]);
      let accepted = head;
      if (head !== p.base) {
        if (
          (await git(i.project, ["rev-parse", "HEAD^"])) !== p.base ||
          (await git(i.project, ["log", "-1", "--format=%B"])) !== p.message
        )
          throw Error("HEAD changed after interruption; state preserved");
        const changed = (
          await git(i.project, [
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            "HEAD",
          ])
        )
          .split("\n")
          .filter(Boolean)
          .sort();
        if (
          JSON.stringify(changed) !==
          JSON.stringify(p.files.map((f) => f.name).sort())
        )
          throw Error("Recovery commit contains unexpected files");
        await clean();
        await assertFiles(i.project, p.files);
      } else {
        const dirtyFiles = await dirty(i.project);
        if (dirtyFiles.some((n) => !p.files.some((f) => f.name === n)))
          throw Error("Resolve unrelated changes before resuming");
        for (const f of staged) {
          if (await exists(path.join(i.project, f.name))) {
            if (
              hash(await readFile(await checkedFile(i.project, f.name))) !==
              f.sha256
            )
              throw Error(
                `Recovery refuses to overwrite user changes: ${f.name}`,
              );
          } else await copyFiles(i.project, [f]);
        }
        const root = path.join(i.project, p.task),
          v = await currentVerification(root);
        if (
          !v?.current ||
          v.report.status !== "behavior_verified" ||
          v.report.fingerprint !== p.fingerprint
        )
          throw Error("Verification became invalid before module commit");
        const { task } = await loadTask(root);
        cancel();
        const result = await executeGo(
          i.project,
          [],
          options.download,
          task.race,
          options.signal,
        );
        await atomicJson(path.join(root, "integration-tests.json"), result);
        const counts = testResults(result, "TestPortsmithJudge");
        if (
          !succeeded(result) ||
          counts.skipped ||
          !task.requiredJudgeTests?.every((n) => counts.passedNames.includes(n))
        )
          throw Error(
            "Project integration tests failed; no commit created, state preserved",
          );
        cancel();
        await unchanged();
        await assertFiles(i.project, p.files);
        accepted = await commit(
          i.project,
          p.files.map((f) => f.name),
          p.message,
        );
        await clean();
        await assertFiles(i.project, p.files);
      }
      state.modules.push({ id: p.module, commit: accepted, files: p.files });
      delete state.pending;
      await save();
      log(
        `${p.module} module accepted and committed as ${accepted.slice(0, 8)}`,
      );
    };
    cancel();
    await validDone(i, state);
    const initialCount = state.modules.length;
    await recover();
    const changes = await dirty(i.project);
    if (changes.some((n) => !allows(n, i.w.bootstrap)))
      throw Error(
        `Only migration preparation materials are committed automatically; resolve unrelated changes first: ${changes.filter((n) => !allows(n, i.w.bootstrap)).join(", ")}`,
      );
    if (changes.length) {
      await commit(
        i.project,
        changes,
        "chore: prepare module migration inputs",
      );
      log("Migration preparation materials committed");
    }
    await save();
    while (state.modules.length - initialCount < limit) {
      cancel();
      await unchanged();
      await clean();
      const next = nextWork(i, state);
      if (!next.module)
        return {
          status: "complete",
          modules: state.modules.map((m) => ({ id: m.id, commit: m.commit })),
        };
      if (!next.next && !next.complete)
        return {
          status: "needs-preparation",
          module: next.module.id,
          verifiedSteps: state.steps.map((s) => s.key),
          blocked: next.blocked,
          note: "Accepted steps are preserved in .portsmith. Add the remaining contracts/tests and rerun the same command; completed steps will not be repeated and the module will not be committed prematurely.",
        };
      if (next.next) {
        const item = next.next,
          taskRel = path.posix.join(i.w.runs, item.key),
          root = path.join(i.project, taskRel);
        const priorItems = state.steps.map(
          (s) => i.items.find((x) => x.key === s.key)!,
        );
        const current = state.steps.filter(
          (s) => i.items.find((x) => x.key === s.key)!.module === item.module,
        );
        const frozenAssets = [...priorItems, item]
          .filter((s) => s.module === item.module)
          .flatMap((s) => s.assets);
        const frozenNames = new Set(frozenAssets.map((f) => f.name));
        const ownNames = [
          ...new Set([
            ...current.flatMap((s) => s.files.map((f) => f.name)),
            ...item.spec.outputs,
            ...item.assets.map((f) => f.name),
          ]),
        ];
        const initial: File[] = [];
        if (current.length) {
          const last = current.at(-1)!;
          for (const f of last.files.filter((f) => !frozenNames.has(f.name)))
            initial.push({
              name: f.name,
              data: await readFile(
                await checkedFile(
                  path.join(i.project, last.task, "candidate"),
                  f.name,
                ),
              ),
            });
        }
        const seed: File[] = [...i.baseline, ...frozenAssets];
        for (const m of state.modules)
          for (const f of m.files.filter(
            (f) =>
              !f.name.startsWith("migration/results/") &&
              !priorItems.some((s) => s.judge.some((j) => j.name === f.name)),
          ))
            seed.push({
              name: f.name,
              data: await readFile(await checkedFile(i.project, f.name)),
            });
        const judges = [...priorItems, item].flatMap((s) => s.judge),
          tests = [...priorItems, item].flatMap((s) => s.spec.tests);
        const taskSeal = hash(
          JSON.stringify({
            step: item.seal,
            initial: entries(initial),
            seed: entries(seed),
            judges: entries(judges),
            mod: hash(i.mod),
            sum: i.sum && hash(i.sum),
          }),
        );
        if (!(await exists(root))) {
          const temp = root + ".preparing";
          if (await exists(temp))
            throw Error(
              `Interrupted preparation directory exists: ${temp}. Confirm the old process has exited, then move it aside before continuing`,
            );
          try {
            await prepareTask({
              source: i.source,
              out: temp,
              files: item.spec.sources,
              revision: i.p.revision,
              goal: `Module ${item.module}, step ${item.key}.\n${item.spec.goal}\nRequired outputs: ${item.spec.outputs.join(", ")}. Earlier files in this module may be updated for integration, but cumulative acceptance must pass. Do not claim the entire module is complete.`,
              rules: path.join(i.root, "RULEBOOK.md"),
              goMod: path.join(i.project, "go.mod"),
              goSum: i.sum ? path.join(i.project, "go.sum") : undefined,
              unit: item.key,
              planDigest: taskSeal,
              contract: item.contract,
              judgeFiles: judges,
              requiredJudgeTests: tests,
              race: [...priorItems, item].some((s) => s.spec.race),
              writableFiles: [
                ...ownNames.filter((n) => !frozenNames.has(n)),
                "NOTES.md",
              ],
              seed,
              initial,
              moduleTask: true,
            });
            await rename(temp, root);
          } catch (e) {
            await rm(temp, { recursive: true, force: true });
            throw e;
          }
        }
        await withLock(root, async () => {
          const { task } = await loadTask(root);
          if (task.planDigest !== taskSeal)
            throw Error(
              `Materials or dependencies changed for active step ${item.key}; review and move aside its unfinished task directory before retrying. Accepted steps are preserved`,
            );
          let v = await currentVerification(root),
            feedback: string | undefined;
          const validate = async () => {
            const files = await candidateFiles(root);
            if (ownNames.some((n) => !files.some((f) => f.name === n)))
              throw Error("Candidate is missing required outputs");
            const allowed = new Set([
              ...ownNames,
              ...seed.map((f) => f.name),
              "NOTES.md",
              "go.mod",
              "LICENSE",
              ...(i.sum ? ["go.sum"] : []),
            ]);
            if (files.some((f) => !allowed.has(f.name)))
              throw Error("Candidate contains unauthorized files");
            await verifyPort(root, options.download, options.signal);
            return currentVerification(root);
          };
          // Recover a fully written candidate after interruption without another model call.
          if (!v?.current || v.report.status !== "behavior_verified") {
            try {
              v = await validate();
            } catch (e) {
              feedback = String(e);
            }
          }
          for (
            let attempt = 0;
            !v?.current || v.report.status !== "behavior_verified";
            attempt++
          ) {
            if (attempts > 0 && attempt >= attempts)
              throw Error(
                `${item.key} reached the limit of ${attempts} generation/repair attempts for this run; candidate and progress preserved. Rerun to continue.\n${v?.current ? verificationDiagnostics(v.report, 2000) : (feedback ?? "No valid verification report yet")}\nReport: ${path.join(root, "verification.json")}`,
              );
            cancel();
            state.attempts[item.key] = (state.attempts[item.key] ?? 0) + 1;
            await save();
            log(`${item.key} generation/repair ${state.attempts[item.key]}`);
            const generated = await options.generate(root, feedback);
            cancel();
            if (
              [
                "model_error",
                "cancelled",
                "output_limit",
                "turn_limit",
                "timeout",
              ].includes(generated.status)
            )
              throw Error(
                `Model run failed: ${generated.error ?? generated.status}; details: ${path.join(root, "last-run.json")}; candidate preserved`,
              );
            try {
              v = await validate();
              feedback =
                v?.report.status === "behavior_verified"
                  ? undefined
                  : "Cumulative verification failed; read diagnostics and repair without modifying frozen judges";
            } catch (e) {
              v = undefined;
              feedback = String(e);
            }
          }
          cancel();
          await unchanged();
          const files = (await candidateFiles(root)).filter((f) =>
            ownNames.includes(f.name),
          );
          state.steps.push({
            key: item.key,
            seal: item.seal,
            task: taskRel,
            fingerprint: await fingerprint(root),
            files: entries(files),
          });
          await save();
          log(
            `${item.key} passed cumulative acceptance and was saved; module not yet committed`,
          );
        });
        continue;
      }
      const module = next.module;
      const last = state.steps
        .filter(
          (s) => i.items.find((x) => x.key === s.key)!.module === module.id,
        )
        .at(-1)!;
      const root = path.join(i.project, last.task);
      // Reverify with current dependency manifest; dependency edits cannot reuse old receipts.
      const { task } = await loadTask(root);
      if (
        task.goModSha256 !== hash(i.mod) ||
        task.goSumSha256 !== (i.sum && hash(i.sum))
      )
        throw Error(
          "Dependencies changed after the last step; add a module regression step instead of committing with old acceptance evidence",
        );
      const report = await verifyPort(root, options.download, options.signal);
      if (report.status !== "behavior_verified")
        throw Error(
          "Final cumulative module verification failed; no commit created",
        );
      cancel();
      await unchanged();
      const files: File[] = [];
      for (const f of last.files)
        files.push({
          name: f.name,
          data: await readFile(
            await checkedFile(path.join(root, "candidate"), f.name),
          ),
        });
      files.push(
        ...i.items
          .filter((s) => s.module === module.id)
          .flatMap((s) => s.judge),
      );
      files.push({
        name: `migration/results/${module.id}.json`,
        data: Buffer.from(
          JSON.stringify(
            {
              module: module.id,
              upstream: i.p.revision,
              steps: state.steps.filter((s) =>
                s.key.startsWith(module.id + "/"),
              ),
              verification: report,
              planSha256: hash(await readFile(path.join(i.root, "plan.json"))),
            },
            null,
            2,
          ) + "\n",
        ),
      });
      for (const f of files)
        if (await exists(path.join(i.project, f.name)))
          throw Error(
            `Integration refuses to overwrite an existing file: ${f.name}`,
          );
      const staging = path.posix.join(i.w.runs, `${module.id}-integration`);
      if (await exists(path.join(i.project, staging)))
        await rm(path.join(i.project, staging), { recursive: true });
      await copyFiles(path.join(i.project, staging), files);
      state.pending = {
        module: module.id,
        base: await git(i.project, ["rev-parse", "HEAD"]),
        files: entries(files),
        message: `feat: port ${module.id}\n\nPortsmith-Module: ${i.identity}\nPortsmith-Candidate: ${report.fingerprint}`,
        task: last.task,
        fingerprint: report.fingerprint,
        staging,
      };
      await save();
      await recover();
    }
    return {
      status:
        state.modules.length === i.p.modules.length
          ? "complete"
          : "paused-at-limit",
      modules: state.modules.map((m) => ({ id: m.id, commit: m.commit })),
    };
  });
}
