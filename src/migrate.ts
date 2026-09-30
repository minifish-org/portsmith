import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
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
import { cleanEnv, executeGo, succeeded, testResults } from "./process.js";
import { loadPlan, planDigest, selectUnit } from "./plan.js";
import {
  candidateFiles,
  fingerprint,
  loadTask,
  prepareTask,
} from "./workspace.js";
import { currentVerification, verifyPort, VERIFIER_VERSION } from "./verify.js";
import { verificationDiagnostics } from "./diagnostics.js";

type File = { name: string; data: Buffer };
type Entry = { name: string; sha256: string };
type UnitConfig = {
  contract: string;
  judge: string;
  outputs: string[];
  tests: string[];
  race?: boolean;
};
type Workflow = {
  version: 1;
  project: string;
  runs: string;
  bootstrap: string[];
  units: Record<string, UnitConfig>;
};
type Pending = {
  id: string;
  base: string;
  fingerprint: string;
  files: Entry[];
  message: string;
};
type State = {
  version: 1;
  digest: string;
  completed: { id: string; commit: string; files: Entry[] }[];
  pending?: Pending;
  attempts: Record<string, number>;
  error?: string;
};
const exec = promisify(execFile);

export async function git(root: string, args: string[]) {
  const result = await exec("git", args, {
    cwd: root,
    env: cleanEnv(),
    maxBuffer: Infinity,
  });
  return result.stdout.trimEnd();
}
export async function exists(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
export async function dirty(root: string) {
  // NUL-delimited porcelain also handles spaces; renames are rejected rather than guessed.
  const data = await git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const entries = data.split("\0").filter(Boolean);
  if (entries.some((e) => /^[RC]|^.[RC]/.test(e)))
    throw Error("Resolve Git renames before continuing the migration");
  return entries.map((e) => e.slice(3));
}
export function allows(name: string, roots: string[]) {
  return roots.some((r) => name === r || name.startsWith(r + "/"));
}
export async function commit(root: string, names: string[], message: string) {
  if (!names.length) throw Error("Refusing an empty commit");
  await git(root, ["add", "--", ...names]);
  await git(root, ["commit", "--only", "-m", message, "--", ...names]);
  return git(root, ["rev-parse", "HEAD"]);
}
export async function assertFiles(root: string, files: Entry[]) {
  for (const f of files)
    if (hash(await readFile(await checkedFile(root, f.name))) !== f.sha256)
      throw Error(`Frozen or integrated file changed: ${f.name}`);
}

export async function inspectMigration(planInput: string) {
  const planRoot = await realpath(planInput);
  const config = await readJson<Workflow>(planRoot, "workflow.json");
  if (
    config.version !== 1 ||
    typeof config.project !== "string" ||
    !Array.isArray(config.bootstrap) ||
    !config.units
  )
    throw Error("Invalid workflow.json");
  const project = await realpath(path.resolve(planRoot, config.project));
  relativeName(config.runs);
  if (!config.runs.startsWith(".portsmith/"))
    throw Error("Task directories must be under .portsmith/");
  for (const p of config.bootstrap) {
    relativeName(p);
    if (
      p.startsWith(".git/") ||
      p === ".git" ||
      p.startsWith(".portsmith") ||
      p.startsWith(".env")
    )
      throw Error("bootstrap must not contain internal state or credentials");
  }
  if ((await git(project, ["rev-parse", "--show-toplevel"])) !== project)
    throw Error("project must be the target Git repository root");
  const plan = await loadPlan(planRoot);
  const mod = await readFile(await checkedFile(project, "go.mod"));
  const fixtureMod = await readFile(await checkedFile(planRoot, "go.mod"));
  const sum = (await exists(path.join(project, "go.sum")))
    ? await readFile(await checkedFile(project, "go.sum"))
    : undefined;
  const assets: File[] = [
    { name: "workflow.json", data: Buffer.from(JSON.stringify(config)) },
    { name: "project/go.mod", data: mod },
    { name: "fixtures/go.mod", data: fixtureMod },
  ];
  if (sum) assets.push({ name: "go.sum", data: sum });
  const owned = new Set<string>();
  const units = [];
  for (const unit of plan.units) {
    await selectUnit(planRoot, unit.id, project);
    const spec = config.units[unit.id];
    if (!spec || !spec.outputs?.length || !spec.tests?.length)
      throw Error(`Missing task configuration: ${unit.id}`);
    relativeName(spec.contract);
    relativeName(spec.judge);
    const contract = await readFile(await checkedFile(planRoot, spec.contract));
    const judge = await snapshotFiles(path.join(planRoot, spec.judge));
    const text = judge
      .filter((f) => f.name.endsWith("_test.go"))
      .map((f) => f.data.toString())
      .join("\n");
    for (const name of spec.tests) {
      if (
        !/^TestPortsmithJudge\w+$/.test(name) ||
        !new RegExp(`func\\s+${name}\\s*\\(`).test(text)
      )
        throw Error(`Missing independent tests: ${unit.id}/${name}`);
    }
    if (new Set(spec.tests).size !== spec.tests.length)
      throw Error(`Duplicate test: ${unit.id}`);
    for (const file of [...spec.outputs, ...judge.map((f) => f.name)]) {
      relativeName(file);
      if (!file.endsWith(".go") && !file.includes("/testdata/"))
        throw Error(`Only Go and testdata outputs are allowed: ${file}`);
      if (!file.startsWith(unit.targetPackage + "/"))
        throw Error(`Output is outside the task package: ${file}`);
      if (owned.has(file))
        throw Error(`Task output or judge path conflict: ${file}`);
      owned.add(file);
    }
    if (judge.some((f) => spec.outputs.includes(f.name)))
      throw Error("Candidate cannot overwrite a judge");
    if (
      !spec.outputs.some((f) => !f.endsWith("_test.go")) ||
      !spec.outputs.some((f) => f.endsWith("_test.go"))
    )
      throw Error(
        `Task requires implementation and candidate tests: ${unit.id}`,
      );
    assets.push(
      { name: spec.contract, data: contract },
      ...judge.map((f) => ({ name: `${spec.judge}/${f.name}`, data: f.data })),
    );
    units.push({ unit, spec, contract: contract.toString(), judge });
  }
  const digest = hash(
    JSON.stringify({
      plan: await planDigest(planRoot),
      verifier: VERIFIER_VERSION,
      assets: assets.map((f) => [f.name, hash(f.data)]),
    }),
  );
  return { planRoot, project, config, plan, units, digest, mod, sum };
}

export type MigrationOptions = {
  plan: string;
  commit: boolean;
  check?: boolean;
  maxAttempts?: number;
  maxUnits?: number;
  download?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  generate: (
    task: string,
    feedback?: string,
  ) => Promise<{ status: string; error?: string; stopReason?: string }>;
};

export async function migrate(options: MigrationOptions) {
  const workflow = await readJson<{ version: number }>(
    options.plan,
    "workflow.json",
  );
  if (workflow.version === 2) {
    const { migrateModules } = await import("./modules.js");
    return migrateModules(options);
  }
  const inspected = await inspectMigration(options.plan);
  const { project, planRoot, config, units, digest, mod, sum } = inspected;
  if (options.check)
    return {
      status: "ready",
      units: units.map(({ unit, spec }) => ({
        id: unit.id,
        tests: spec.tests.length,
        outputs: spec.outputs,
      })),
      note: "Preparation checked; no model calls made and Go behavior is not yet implemented",
    };
  if (!options.commit)
    throw Error(
      "Automatic integration requires --commit, allowing preparation and per-module commits; it does not push",
    );
  const maxAttempts = options.maxAttempts ?? 0,
    maxUnits = options.maxUnits ?? units.length;
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 0 ||
    !Number.isInteger(maxUnits) ||
    maxUnits < 1
  )
    throw Error(
      "max-attempts must be non-negative (0 means unlimited); max-units must be positive",
    );
  const log = options.onProgress ?? (() => {});
  const checkCancel = () => {
    if (options.signal?.aborted)
      throw Error(
        "Migration cancelled; progress preserved. Rerun the same command to continue",
      );
  };
  const control = path.join(project, ".portsmith");
  await mkdir(control, { recursive: true });
  // Refuse repositories where these local receipts could accidentally be committed.
  await git(project, ["check-ignore", ".portsmith/migrate.json"]);
  return withLock(control, async () => {
    const journal = path.join(control, "migrate.json");
    let state: State;
    if (await exists(journal))
      state = await readJson<State>(control, "migrate.json");
    else state = { version: 1, digest, completed: [], attempts: {} };
    if (state.version !== 1 || state.digest !== digest)
      throw Error(
        "Plan, interfaces, tests, dependencies or verifier changed; review existing tasks instead of reusing old execution receipts",
      );
    const save = () => atomicJson(journal, state);
    const ensureClean = async () => {
      const names = await dirty(project);
      if (names.length)
        throw Error(
          `Working tree contains changes outside this transaction: ${names.join(", ")}`,
        );
    };
    const recover = async () => {
      const pending = state.pending;
      if (!pending) return;
      const taskRoot = path.join(project, config.runs, pending.id);
      const staged = await snapshotFiles(path.join(taskRoot, "integration"));
      if (
        JSON.stringify(
          staged
            .map((f) => ({ name: f.name, sha256: f.sha256 }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        ) !==
        JSON.stringify(
          [...pending.files].sort((a, b) => a.name.localeCompare(b.name)),
        )
      )
        throw Error("Integration staging snapshot changed");
      const head = await git(project, ["rev-parse", "HEAD"]);
      let committed: string;
      if (head !== pending.base) {
        const parent = await git(project, ["rev-parse", "HEAD^"]);
        const message = await git(project, ["log", "-1", "--format=%B"]);
        if (parent !== pending.base || message !== pending.message)
          throw Error(
            "Git HEAD changed after interruption; state preserved for review",
          );
        await ensureClean();
        await assertFiles(project, pending.files);
        const changed = (
          await git(project, [
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
          JSON.stringify(pending.files.map((f) => f.name).sort())
        )
          throw Error("Recovery commit contains unexpected files");
        committed = head;
      } else {
        const allowed = pending.files.map((f) => f.name);
        const unexpected = (await dirty(project)).filter(
          (n) => !allowed.includes(n),
        );
        if (unexpected.length)
          throw Error(
            `Resolve unrelated changes before resuming: ${unexpected.join(", ")}`,
          );
        for (const f of staged) {
          const destination = path.join(project, f.name);
          if (await exists(destination)) {
            if (
              hash(await readFile(await checkedFile(project, f.name))) !==
              f.sha256
            )
              throw Error(
                `Recovery found user changes and refuses to overwrite them: ${f.name}`,
              );
          } else await copyFiles(project, [f]);
        }
        await assertFiles(project, pending.files);
        checkCancel();
        const { task } = await loadTask(taskRoot);
        const verified = await currentVerification(taskRoot);
        if (
          !verified?.current ||
          verified.report.status !== "behavior_verified" ||
          verified.report.fingerprint !== pending.fingerprint
        )
          throw Error("Verification became invalid before integration");
        const integrationTests = await executeGo(
          project,
          [],
          options.download,
          task.race,
          options.signal,
        );
        await atomicJson(
          path.join(taskRoot, "integration-tests.json"),
          integrationTests,
        );
        const counts = testResults(integrationTests, "TestPortsmithJudge");
        if (
          !succeeded(integrationTests) ||
          counts.skipped ||
          !(task.requiredJudgeTests ?? []).every((n) =>
            counts.passedNames.includes(n),
          )
        )
          throw Error(
            "Pith integration tests failed; no commit created. See integration-tests.json; state preserved",
          );
        checkCancel();
        await assertFiles(project, pending.files);
        committed = await commit(project, allowed, pending.message);
        await ensureClean();
        await assertFiles(project, pending.files);
      }
      state.completed.push({
        id: pending.id,
        commit: committed,
        files: pending.files,
      });
      delete state.pending;
      delete state.error;
      await save();
      log(`${pending.id} integrated and committed as ${committed.slice(0, 8)}`);
    };
    try {
      checkCancel();
      const initialCompleted = state.completed.length;
      await recover();
      for (const completed of state.completed) {
        await git(project, [
          "merge-base",
          "--is-ancestor",
          completed.commit,
          "HEAD",
        ]);
        await assertFiles(project, completed.files);
      }
      const changes = await dirty(project);
      if (changes.length && !(await exists(journal))) {
        const unexpected = changes.filter((n) => !allows(n, config.bootstrap));
        if (unexpected.length)
          throw Error(
            `The first run only commits preparation files automatically; resolve these changes first: ${unexpected.join(", ")}`,
          );
        checkCancel();
        await commit(
          project,
          changes,
          "chore: prepare Portsmith migration inputs",
        );
        log(
          "Preparation commit created for the migration plan, interfaces and acceptance tests",
        );
      }
      await ensureClean();
      await save();
      let finished = state.completed.length - initialCompleted;
      while (state.completed.length < units.length && finished < maxUnits) {
        checkCancel();
        if ((await inspectMigration(planRoot)).digest !== digest)
          throw Error(
            "Migration inputs changed during execution; stopped to avoid mixing snapshots",
          );
        const done = new Set(state.completed.map((s) => s.id));
        const item = units.find(
          ({ unit }) =>
            !done.has(unit.id) && unit.dependsOn.every((id) => done.has(id)),
        );
        if (!item)
          throw Error(
            "No task can advance; check the dependency graph and committed records",
          );
        const { unit, spec } = item;
        const taskRoot = path.join(project, config.runs, unit.id);
        const prior = units.filter((x) => done.has(x.unit.id));
        const judgeFiles = [...prior, item].flatMap((x) => x.judge);
        const requiredJudgeTests = [...prior, item].flatMap(
          (x) => x.spec.tests,
        );
        if (!(await exists(taskRoot))) {
          const temp = taskRoot + ".preparing";
          if (await exists(temp))
            throw Error(
              `Interrupted preparation directory exists: ${temp}. Confirm the previous process has stopped, then move it aside and retry`,
            );
          const seed: File[] = [];
          for (const previous of prior)
            for (const name of previous.spec.outputs)
              seed.push({
                name,
                data: await readFile(await checkedFile(project, name)),
              });
          try {
            await prepareTask({
              source: path.resolve(project, inspected.plan.source),
              out: temp,
              revision: inspected.plan.revision,
              goal:
                unit.goal +
                "\nAcceptance:\n" +
                unit.acceptance.join("\n") +
                "\nRequired output files:\n" +
                spec.outputs.join("\n") +
                "\nCandidate tests must use the normal Test prefix, not TestPortsmithJudge.",
              files: [...unit.files, ...unit.references],
              rules: path.join(planRoot, "RULEBOOK.md"),
              goMod: path.join(project, "go.mod"),
              goSum: sum ? path.join(project, "go.sum") : undefined,
              judgeFiles,
              unit: unit.id,
              dependsOn: unit.dependsOn,
              planDigest: await planDigest(planRoot),
              writableFiles: [...spec.outputs, "NOTES.md"],
              seed,
              contract: item.contract,
              requiredJudgeTests,
              race: [...prior, item].some((x) => x.spec.race),
            });
            await rename(temp, taskRoot);
          } catch (e) {
            await rm(temp, { recursive: true, force: true });
            throw e;
          }
          log(`${unit.id} prepared with ${seed.length} seed files`);
        }
        await withLock(taskRoot, async () => {
          const { task } = await loadTask(taskRoot);
          if (
            task.unit !== unit.id ||
            task.planDigest !== (await planDigest(planRoot)) ||
            JSON.stringify(task.writableFiles) !==
              JSON.stringify([...spec.outputs, "NOTES.md"]) ||
            JSON.stringify(task.requiredJudgeTests) !==
              JSON.stringify(requiredJudgeTests) ||
            task.goModSha256 !== hash(mod) ||
            task.race !== [...prior, item].some((x) => x.spec.race)
          )
            throw Error(
              `Task ${unit.id} was not prepared by the current workflow and cannot be reused`,
            );
          const expectedJudge = judgeFiles.map((f) => ({
            name: f.name,
            sha256: hash(f.data),
          }));
          const expectedSeed = await Promise.all(
            prior
              .flatMap((x) => x.spec.outputs)
              .map(async (name) => ({
                name,
                sha256: hash(await readFile(await checkedFile(project, name))),
              })),
          );
          if (
            JSON.stringify(task.judgeFiles) !== JSON.stringify(expectedJudge) ||
            JSON.stringify(task.seedFiles ?? []) !==
              JSON.stringify(expectedSeed) ||
            task.rulesSha256 !==
              hash(
                await readFile(await checkedFile(planRoot, "RULEBOOK.md")),
              ) ||
            task.goSumSha256 !== (sum ? hash(sum) : undefined)
          )
            throw Error(
              `Frozen tests, rules or seed code for ${unit.id} do not match the current plan`,
            );
          let verification = await currentVerification(taskRoot);
          let feedback: string | undefined;
          for (
            let attempt = 0;
            !verification?.current ||
            verification.report.status !== "behavior_verified";
            attempt++
          ) {
            if (maxAttempts > 0 && attempt >= maxAttempts)
              throw Error(
                `${unit.id} reached the limit of ${maxAttempts} generation/repair attempts for this run; candidate and progress preserved. Rerun the same command to continue.\n${verification?.current ? verificationDiagnostics(verification.report, 2000) : (feedback ?? "No valid verification report yet")}\nReport: ${path.join(taskRoot, "verification.json")}`,
              );
            checkCancel();
            state.attempts[unit.id] = (state.attempts[unit.id] ?? 0) + 1;
            await save();
            log(`${unit.id} generation/repair ${state.attempts[unit.id]}`);
            const result = await options.generate(taskRoot, feedback);
            checkCancel();
            if (
              [
                "model_error",
                "cancelled",
                "output_limit",
                "turn_limit",
                "timeout",
              ].includes(result.status)
            )
              throw Error(
                `${unit.id} model run failed: ${result.error ?? result.status}; details: ${path.join(taskRoot, "last-run.json")}; candidate and progress preserved`,
              );
            try {
              const files = await candidateFiles(taskRoot);
              const missing = spec.outputs.filter(
                (n) => !files.some((f) => f.name === n),
              );
              if (missing.length)
                throw Error(`Missing required outputs: ${missing.join(", ")}`);
              const allowed = new Set([
                ...(task.writableFiles ?? []),
                ...(task.seedFiles ?? []).map((f) => f.name),
                "go.mod",
                "LICENSE",
                ...(sum ? ["go.sum"] : []),
              ]);
              if (files.some((f) => !allowed.has(f.name)))
                throw Error("Candidate contains unauthorized outputs");
              const report = await verifyPort(
                taskRoot,
                options.download,
                options.signal,
              );
              verification = await currentVerification(taskRoot);
              feedback =
                report.status === "behavior_verified"
                  ? undefined
                  : `Previous verification failed: ${report.status}. Repair using verification.json; do not modify frozen files.`;
              log(`${unit.id} verification: ${report.status}`);
            } catch (e) {
              verification = undefined;
              feedback = e instanceof Error ? e.message : String(e);
              log(feedback);
            }
          }
          checkCancel();
          await ensureClean();
          if ((await inspectMigration(planRoot)).digest !== digest)
            throw Error(
              "Migration inputs changed after acceptance; refusing integration",
            );
          const integration: File[] = [];
          for (const name of spec.outputs)
            integration.push({
              name,
              data: await readFile(
                await checkedFile(taskRoot, `candidate/${name}`),
              ),
            });
          integration.push(...item.judge);
          const receipt = {
            unit: unit.id,
            upstream: inspected.plan.revision,
            digest,
            candidate: await fingerprint(taskRoot),
            verification: verification!.report,
          };
          integration.push({
            name: `migration/results/${unit.id}.json`,
            data: Buffer.from(JSON.stringify(receipt, null, 2) + "\n"),
          });
          if (await exists(path.join(taskRoot, "candidate/NOTES.md")))
            integration.push({
              name: `migration/results/${unit.id}.md`,
              data: await readFile(path.join(taskRoot, "candidate/NOTES.md")),
            });
          for (const f of integration)
            if (await exists(path.join(project, f.name)))
              throw Error(
                `Integration refuses to overwrite an existing file: ${f.name}`,
              );
          const staging = path.join(taskRoot, "integration");
          if (await exists(staging)) await rm(staging, { recursive: true });
          await copyFiles(staging, integration);
          state.pending = {
            id: unit.id,
            base: await git(project, ["rev-parse", "HEAD"]),
            fingerprint: receipt.candidate,
            files: integration.map((f) => ({
              name: f.name,
              sha256: hash(f.data),
            })),
            message: `feat: port ${unit.id}\n\nPortsmith-Plan: ${digest}\nPortsmith-Candidate: ${receipt.candidate}`,
          };
          await save();
          await recover();
        });
        finished++;
      }
      return {
        status:
          state.completed.length === units.length
            ? "complete"
            : "paused-at-limit",
        completed: state.completed.map((c) => ({ id: c.id, commit: c.commit })),
        remaining: units.length - state.completed.length,
      };
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
      // Do not create a journal for a rejected first preflight: bootstrap remains resumable.
      if (await exists(journal)) await save();
      throw e;
    }
  });
}
