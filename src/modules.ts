import { mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
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
    throw Error("重复或无效 ID");
  const done = new Set<string>(),
    visiting = new Set<string>();
  function visit(id: string) {
    if (!nodes.has(id)) throw Error(`未知依赖：${id}`);
    if (done.has(id)) return;
    if (visiting.has(id)) throw Error(`依赖成环：${id}`);
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
    throw Error(`不允许的模块输出：${name}`);
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
    throw Error("模块工作流配置不完整：需要 v2 modules/batches 与执行步骤");
  if (
    w.startPolicy !== undefined &&
    !["all-prepared", "available-steps"].includes(w.startPolicy)
  )
    throw Error("startPolicy 必须为 all-prepared 或 available-steps");
  graph(p.modules);
  graph(p.batches);
  const project = await realpath(path.resolve(root, w.project));
  if ((await git(project, ["rev-parse", "--show-toplevel"])) !== project)
    throw Error("project 必须是目标 Git 根目录");
  relativeName(w.runs);
  if (!w.runs.startsWith(".portsmith/"))
    throw Error("模块任务目录必须在 .portsmith 内");
  for (const n of w.bootstrap) {
    relativeName(n);
    if (
      n.split("/").some((s) => s.startsWith(".git") && s !== ".gitignore") ||
      n.startsWith(".env") ||
      n.startsWith(".portsmith")
    )
      throw Error("bootstrap 不能包含凭据/内部状态");
  }
  const source = await realpath(path.resolve(project, p.source));
  const raw = await readFile(await checkedFile(root, "analysis.json"));
  if (hash(raw) !== p.analysisSha256) throw Error("分析快照变更");
  const analysis = JSON.parse(raw.toString()) as {
    files: { path: string; sha256: string }[];
    configs: { path: string; sha256: string }[];
  };
  const known = new Map(analysis.files.map((f) => [f.path, f.sha256]));
  for (const c of analysis.configs)
    if (hash(await readFile(await checkedFile(source, c.path))) !== c.sha256)
      throw Error(`源码配置已变化：${c.path}`);
  const rules = await readFile(await checkedFile(root, "RULEBOOK.md"));
  const mod = await readFile(await checkedFile(project, "go.mod"));
  const sum = (await exists(path.join(project, "go.sum")))
    ? await readFile(await checkedFile(project, "go.sum"))
    : undefined;
  await checkedFile(root, "go.mod"); // keep fixture trees out of root go test ./...
  const batches = new Map(p.batches.map((b) => [b.id, b]));
  if (Object.keys(w.batches).some((id) => !batches.has(id)))
    throw Error("工作流包含不在计划中的批次");
  const listed = p.modules.flatMap((m) => m.batches);
  if (
    new Set(listed).size !== p.batches.length ||
    listed.length !== p.batches.length ||
    listed.some((id) => !batches.has(id))
  )
    throw Error("批次归属不完整");
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
        throw Error(`批次归属/依赖无效：${id}`);
      const cfg = w.batches[id];
      if (
        !cfg ||
        !["ready", "partial", "planned"].includes(cfg.status) ||
        !Array.isArray(cfg.steps) ||
        (cfg.status !== "ready" && !cfg.reason)
      )
        throw Error(`批次准备状态缺失：${id}`);
      if (
        (cfg.status === "planned" && cfg.steps.length) ||
        (cfg.status === "ready" && !cfg.steps.length)
      )
        throw Error(`批次状态和步骤不一致：${id}`);
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
          throw Error(`步骤配置无效：${id}/${s.id}`);
        ids.add(s.id);
        const sources = [];
        for (const name of s.sources) {
          if (![...b.sources, ...b.references].includes(name))
            throw Error(`来源不属于批次：${id}/${name}`);
          const data = await readFile(await checkedFile(source, name));
          if (!known.has(name) || known.get(name) !== hash(data))
            throw Error(`源码在分析后变化：${name}`);
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
            throw Error(`静态资产目标冲突或未登记：${a.target}`);
          const data = await readFile(await checkedFile(root, a.source));
          if (hash(data) !== a.sha256)
            throw Error(`静态资产变更或超限：${a.source}`);
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
          throw Error(`独立测试缺失：${id}/${s.id}`);
        if (
          !s.outputs.some((n) => n.endsWith("_test.go")) ||
          !s.outputs.some((n) => n.endsWith(".go") && !n.endsWith("_test.go"))
        )
          throw Error(`步骤需要实现和自测：${id}/${s.id}`);
        for (const n of s.outputs) {
          outputName(n);
          if (assetOwners.has(n))
            throw Error(`静态资产不可声明为可写输出：${n}`);
          if (
            !b.outputs.includes(n) &&
            !(
              n.endsWith("_test.go") &&
              b.outputs.some(
                (o) => path.posix.dirname(o) === path.posix.dirname(n),
              )
            )
          )
            throw Error(`输出未列入计划：${id}/${n}`);
          if (outputOwners.has(n) && outputOwners.get(n) !== m.id)
            throw Error(`模块输出冲突：${n}`);
          outputOwners.set(n, m.id);
        }
        for (const f of judge) {
          relativeName(f.name);
          if (
            (!f.name.endsWith("_test.go") && !f.name.includes("/testdata/")) ||
            judgeOwners.has(f.name)
          )
            throw Error(`独立测试路径冲突或非法：${f.name}`);
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
        throw Error(`ready 批次尚未覆盖全部输出：${id}`);
    }
  for (const n of judgeOwners)
    if (outputOwners.has(n)) throw Error(`候选可覆盖独立测试：${n}`);
  const names = items.flatMap((s) => s.spec.tests);
  if (new Set(names).size !== names.length)
    throw Error("不同步骤的独立测试名必须唯一");
  if (
    w.bootstrap.some((n) =>
      [...outputOwners.keys()].some((o) => allows(o, [n])),
    )
  )
    throw Error("bootstrap 不能包括产品输出");
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
      rules: hash(rules),
      license: hash(await readFile(await checkedFile(source, "LICENSE"))),
    }),
  );
  return { root, p, w, project, source, mod, sum, items, identity };
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
    throw Error("来源/模块结构/规则变更；需重新规划，不能复用进度");
  const verified = new Set(state.steps.map((s) => s.key));
  if (
    verified.size !== state.steps.length ||
    new Set(state.modules.map((m) => m.id)).size !== state.modules.length
  )
    throw Error("模块进度记录重复");
  for (const d of state.steps) {
    const item = i.items.find((s) => s.key === d.key);
    if (!item || item.seal !== d.seal)
      throw Error(`已完成步骤的来源/契约/验收已变更：${d.key}`);
    const siblings = i.items.filter((s) => s.batch === item.batch);
    if (
      siblings
        .slice(
          0,
          siblings.findIndex((s) => s.key === d.key),
        )
        .some((s) => !verified.has(s.key))
    )
      throw Error(`不能在已完成步骤前插入新步骤：${d.key}`);
    const batch = i.p.batches.find((b) => b.id === item.batch)!;
    if (
      batch.dependsOn.some(
        (id) =>
          i.w.batches[id].status !== "ready" ||
          i.items.some((s) => s.batch === id && !verified.has(s.key)),
      )
    )
      throw Error(`已完成步骤的前置批次被扩展：${d.key}`);
    const root = path.join(i.project, d.task);
    const v = await currentVerification(root);
    if (
      !v?.current ||
      v.report.status !== "behavior_verified" ||
      v.report.fingerprint !== d.fingerprint
    )
      throw Error(`已完成步骤验证失效：${d.key}`);
    await assertFiles(path.join(root, "candidate"), d.files);
  }
  for (const m of state.modules) {
    if (!i.p.modules.some((x) => x.id === m.id))
      throw Error(`未知已提交模块：${m.id}`);
    if (
      i.p.modules
        .find((x) => x.id === m.id)!
        .batches.some((b) => i.w.batches[b].status !== "ready") ||
      i.items.some((s) => s.module === m.id && !verified.has(s.key))
    )
      throw Error(`已提交模块的执行范围变更：${m.id}`);
    await git(i.project, ["merge-base", "--is-ancestor", m.commit, "HEAD"]);
    await assertFiles(i.project, m.files);
  }
}

export async function migrateModules(options: MigrationOptions) {
  const i = await inspectModules(options.plan);
  const control = path.join(i.project, ".portsmith"),
    journal = path.join(control, "modules.json");
  const fresh = (): State => ({
    version: 2,
    identity: i.identity,
    steps: [],
    modules: [],
    attempts: {},
  });
  const load = async () =>
    (await exists(journal))
      ? readJson<State>(control, "modules.json")
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
      note:
        blocked.length && startPolicy === "all-prepared"
          ? "完整计划尚未准备齐全；本次不会调用模型、创建任务或提交。首步通过不能解锁缺失材料，请先补齐全部批次。"
          : "准备状态不代表 Go 模块已经迁移完成；--commit 才会调用模型并保存进度。",
    };
  }
  if (!options.commit)
    throw Error("模块迁移需要 --commit；允许准备提交和整模块提交，不会 push");
  const attempts = options.maxAttempts ?? 0,
    limit = options.maxUnits ?? i.p.modules.length;
  if (
    !Number.isInteger(attempts) ||
    attempts < 0 ||
    !Number.isInteger(limit) ||
    limit < 1
  )
    throw Error(
      "max-attempts 为非负整数（0 不限制）；max-units 为正整数（v2 计模块）",
    );
  await mkdir(control, { recursive: true });
  await git(i.project, ["check-ignore", ".portsmith/modules.json"]);
  const log = options.onProgress ?? (() => {});
  const cancel = () => {
    if (options.signal?.aborted) throw Error("迁移已取消；模块候选与进度保留");
  };
  return withLock(control, async () => {
    const state = await load();
    const save = () => atomicJson(journal, state);
    const clean = async () => {
      const d = await dirty(i.project);
      if (d.length) throw Error(`正式工作区存在其他修改：${d.join(", ")}`);
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
        throw Error("运行中迁移材料变化；已停止，重跑前审查材料");
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
        throw Error("模块集成暂存被修改");
      const head = await git(i.project, ["rev-parse", "HEAD"]);
      let accepted = head;
      if (head !== p.base) {
        if (
          (await git(i.project, ["rev-parse", "HEAD^"])) !== p.base ||
          (await git(i.project, ["log", "-1", "--format=%B"])) !== p.message
        )
          throw Error("中断后 HEAD 发生其他变化，保留现场");
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
          throw Error("恢复提交包含其他文件");
        await clean();
        await assertFiles(i.project, p.files);
      } else {
        const dirtyFiles = await dirty(i.project);
        if (dirtyFiles.some((n) => !p.files.some((f) => f.name === n)))
          throw Error("恢复前需处理其他修改");
        for (const f of staged) {
          if (await exists(path.join(i.project, f.name))) {
            if (
              hash(await readFile(await checkedFile(i.project, f.name))) !==
              f.sha256
            )
              throw Error(`恢复拒绝覆盖用户修改：${f.name}`);
          } else await copyFiles(i.project, [f]);
        }
        const root = path.join(i.project, p.task),
          v = await currentVerification(root);
        if (
          !v?.current ||
          v.report.status !== "behavior_verified" ||
          v.report.fingerprint !== p.fingerprint
        )
          throw Error("模块提交前验证已失效");
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
          throw Error("正式集成测试未通过；未提交，保留现场");
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
      log(`${p.module} 模块已验收并提交 ${accepted.slice(0, 8)}`);
    };
    cancel();
    await validDone(i, state);
    const initialCount = state.modules.length;
    await recover();
    const changes = await dirty(i.project);
    if (changes.some((n) => !allows(n, i.w.bootstrap)))
      throw Error(
        `只自动提交迁移准备材料；请先处理其他修改：${changes.filter((n) => !allows(n, i.w.bootstrap)).join(", ")}`,
      );
    if (changes.length) {
      await commit(
        i.project,
        changes,
        "chore: prepare module migration inputs",
      );
      log("迁移准备材料已提交");
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
          note: "已验收步骤保留在 .portsmith；补充后续契约/测试后重跑同一命令，不会重做已完成步骤，也不会提前提交整个模块。",
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
        const seed: File[] = [...frozenAssets];
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
            throw Error(`存在中断准备目录 ${temp}；确认旧进程结束后移走再继续`);
          try {
            await prepareTask({
              source: i.source,
              out: temp,
              files: item.spec.sources,
              revision: i.p.revision,
              goal: `模块 ${item.module}，内部步骤 ${item.key}。\n${item.spec.goal}\n必须创建：${item.spec.outputs.join(", ")}。本模块前面文件可为整合修改，但必须通过累计验收。不得宣称整个模块完成。`,
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
              `进行中步骤的材料或依赖已变化：${item.key}；需审查并移走该未完成任务目录后重试，已验收步骤保留`,
            );
          let v = await currentVerification(root),
            feedback: string | undefined;
          const validate = async () => {
            const files = await candidateFiles(root);
            if (ownNames.some((n) => !files.some((f) => f.name === n)))
              throw Error("候选缺少必需输出");
            const allowed = new Set([
              ...ownNames,
              ...seed.map((f) => f.name),
              "NOTES.md",
              "go.mod",
              "LICENSE",
              ...(i.sum ? ["go.sum"] : []),
            ]);
            if (files.some((f) => !allowed.has(f.name)))
              throw Error("候选存在未授权文件");
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
                `${item.key} 达到本次 ${attempts} 次生成/修复上限；候选与进度保留，重跑可继续。\n${v?.current ? verificationDiagnostics(v.report, 2000) : (feedback ?? "尚无有效验证报告")}\n报告：${path.join(root, "verification.json")}`,
              );
            cancel();
            state.attempts[item.key] = (state.attempts[item.key] ?? 0) + 1;
            await save();
            log(`${item.key} 生成/修复 ${state.attempts[item.key]}`);
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
                `模型运行失败：${generated.error ?? generated.status}；详情：${path.join(root, "last-run.json")}；候选保留`,
              );
            try {
              v = await validate();
              feedback =
                v?.report.status === "behavior_verified"
                  ? undefined
                  : "累计验证失败，请读取诊断修复；不可修改冻结 judge";
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
          log(`${item.key} 已通过累计验收并保存；正式模块尚未提交`);
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
          "最后步骤后依赖发生变化；需新增模块回归步骤，不能沿用旧验收提交",
        );
      const report = await verifyPort(root, options.download, options.signal);
      if (report.status !== "behavior_verified")
        throw Error("模块最终累计验证失败，未提交");
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
          throw Error(`集成拒绝覆盖已有文件：${f.name}`);
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
