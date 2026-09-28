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

async function git(root: string, args: string[]) {
  const result = await exec("git", args, {
    cwd: root,
    env: cleanEnv(),
    maxBuffer: 2 * 1024 * 1024,
  });
  return result.stdout.trimEnd();
}
async function exists(file: string) {
  try {
    await lstat(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}
async function dirty(root: string) {
  // NUL-delimited porcelain also handles spaces; renames are rejected rather than guessed.
  const data = await git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const entries = data.split("\0").filter(Boolean);
  if (entries.some((e) => /^[RC]|^.[RC]/.test(e)))
    throw Error("请先处理 Git 重命名，再继续迁移");
  return entries.map((e) => e.slice(3));
}
function allows(name: string, roots: string[]) {
  return roots.some((r) => name === r || name.startsWith(r + "/"));
}
async function commit(root: string, names: string[], message: string) {
  if (!names.length) throw Error("拒绝空提交");
  await git(root, ["add", "--", ...names]);
  await git(root, ["commit", "--only", "-m", message, "--", ...names]);
  return git(root, ["rev-parse", "HEAD"]);
}
async function assertFiles(root: string, files: Entry[]) {
  for (const f of files)
    if (hash(await readFile(await checkedFile(root, f.name))) !== f.sha256)
      throw Error(`已冻结/集成文件发生变化：${f.name}`);
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
    throw Error("workflow.json 无效");
  const project = await realpath(path.resolve(planRoot, config.project));
  relativeName(config.runs);
  if (!config.runs.startsWith(".portsmith/"))
    throw Error("任务目录必须在 .portsmith/ 下");
  for (const p of config.bootstrap) {
    relativeName(p);
    if (
      p.startsWith(".git/") ||
      p === ".git" ||
      p.startsWith(".portsmith") ||
      p.startsWith(".env")
    )
      throw Error("bootstrap 不允许包含内部状态或凭据");
  }
  if ((await git(project, ["rev-parse", "--show-toplevel"])) !== project)
    throw Error("project 必须是目标 Git 仓库根目录");
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
      throw Error(`缺少任务配置：${unit.id}`);
    relativeName(spec.contract);
    relativeName(spec.judge);
    const contract = await readFile(await checkedFile(planRoot, spec.contract));
    const judge = await snapshotFiles(path.join(planRoot, spec.judge), 100);
    const text = judge
      .filter((f) => f.name.endsWith("_test.go"))
      .map((f) => f.data.toString())
      .join("\n");
    for (const name of spec.tests) {
      if (
        !/^TestPortsmithJudge\w+$/.test(name) ||
        !new RegExp(`func\\s+${name}\\s*\\(`).test(text)
      )
        throw Error(`独立测试缺失：${unit.id}/${name}`);
    }
    if (new Set(spec.tests).size !== spec.tests.length)
      throw Error(`重复测试：${unit.id}`);
    for (const file of [...spec.outputs, ...judge.map((f) => f.name)]) {
      relativeName(file);
      if (!file.endsWith(".go") && !file.includes("/testdata/"))
        throw Error(`只允许 Go 与 testdata 输出：${file}`);
      if (!file.startsWith(unit.targetPackage + "/"))
        throw Error(`输出超出任务包：${file}`);
      if (owned.has(file)) throw Error(`任务输出或 judge 路径冲突：${file}`);
      owned.add(file);
    }
    if (judge.some((f) => spec.outputs.includes(f.name)))
      throw Error("候选不能覆盖 judge");
    if (
      !spec.outputs.some((f) => !f.endsWith("_test.go")) ||
      !spec.outputs.some((f) => f.endsWith("_test.go"))
    )
      throw Error(`任务需要实现及候选自测：${unit.id}`);
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
  generate: (task: string, feedback?: string) => Promise<{ status: string }>;
};

export async function migrate(options: MigrationOptions) {
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
      note: "准备已检查；尚未调用模型，也不表示Go行为已实现",
    };
  if (!options.commit)
    throw Error(
      "自动集成需要 --commit，表示允许准备提交及每模块提交；不会 push",
    );
  const maxAttempts = options.maxAttempts ?? 3,
    maxUnits = options.maxUnits ?? units.length;
  if (
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 10 ||
    !Number.isInteger(maxUnits) ||
    maxUnits < 1
  )
    throw Error("max-attempts 应为1–10，max-units 应为正整数");
  const log = options.onProgress ?? (() => {});
  const checkCancel = () => {
    if (options.signal?.aborted)
      throw Error("迁移已取消；进度保留，重跑同一命令继续");
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
        "计划、接口、测试、依赖或验证器已变更；请审查已有任务，不能沿用旧执行收据",
      );
    const save = () => atomicJson(journal, state);
    const ensureClean = async () => {
      const names = await dirty(project);
      if (names.length)
        throw Error(`工作区存在未归入本次事务的修改：${names.join(", ")}`);
    };
    const recover = async () => {
      const pending = state.pending;
      if (!pending) return;
      const taskRoot = path.join(project, config.runs, pending.id);
      const staged = await snapshotFiles(
        path.join(taskRoot, "integration"),
        400,
      );
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
        throw Error("集成暂存快照发生变化");
      const head = await git(project, ["rev-parse", "HEAD"]);
      let committed: string;
      if (head !== pending.base) {
        const parent = await git(project, ["rev-parse", "HEAD^"]);
        const message = await git(project, ["log", "-1", "--format=%B"]);
        if (parent !== pending.base || message !== pending.message)
          throw Error("中断后 Git HEAD 已被其他提交改变；保留现场，请人工核对");
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
          throw Error("恢复提交包含预期之外的文件");
        committed = head;
      } else {
        const allowed = pending.files.map((f) => f.name);
        const unexpected = (await dirty(project)).filter(
          (n) => !allowed.includes(n),
        );
        if (unexpected.length)
          throw Error(`恢复前请处理其他修改：${unexpected.join(", ")}`);
        for (const f of staged) {
          const destination = path.join(project, f.name);
          if (await exists(destination)) {
            if (
              hash(await readFile(await checkedFile(project, f.name))) !==
              f.sha256
            )
              throw Error(`恢复时发现用户修改，拒绝覆盖：${f.name}`);
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
          throw Error("集成前验证已失效");
        const integrationTests = await executeGo(
          project,
          [],
          options.download,
          task.race,
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
            "Pith 集成测试未通过，未提交；查看 integration-tests.json，现场已保留",
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
      log(`${pending.id} 已集成并提交 ${committed.slice(0, 8)}`);
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
            `首次运行只自动提交准备文件；以下修改请先处理：${unexpected.join(", ")}`,
          );
        checkCancel();
        await commit(
          project,
          changes,
          "chore: prepare Portsmith migration inputs",
        );
        log("迁移计划、接口和验收测试已创建准备提交");
      }
      await ensureClean();
      await save();
      let finished = state.completed.length - initialCompleted;
      while (state.completed.length < units.length && finished < maxUnits) {
        checkCancel();
        if ((await inspectMigration(planRoot)).digest !== digest)
          throw Error("运行中迁移输入已变化，停止以避免混用快照");
        const done = new Set(state.completed.map((s) => s.id));
        const item = units.find(
          ({ unit }) =>
            !done.has(unit.id) && unit.dependsOn.every((id) => done.has(id)),
        );
        if (!item) throw Error("没有可推进任务；请检查依赖图与已提交记录");
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
              `存在中断的准备目录 ${temp}；确认原进程停止后移走它再重试`,
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
                "\n验收：\n" +
                unit.acceptance.join("\n") +
                "\n必须创建的文件：\n" +
                spec.outputs.join("\n") +
                "\n候选自测使用普通Test前缀，不能使用TestPortsmithJudge。",
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
          log(`${unit.id} 已准备；自动带入 ${seed.length} 个前置文件`);
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
            throw Error(`${unit.id} 的任务不是当前工作流准备的，不能复用`);
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
            throw Error(`${unit.id} 的冻结测试、规则或前置代码与当前计划不符`);
          let verification = await currentVerification(taskRoot);
          let feedback: string | undefined;
          for (
            let attempt = 0;
            !verification?.current ||
            verification.report.status !== "behavior_verified";
            attempt++
          ) {
            if (attempt >= maxAttempts)
              throw Error(
                `${unit.id} 已达到本次 ${maxAttempts} 次生成/修复上限；查看验证诊断后重跑同一命令继续`,
              );
            checkCancel();
            state.attempts[unit.id] = (state.attempts[unit.id] ?? 0) + 1;
            await save();
            log(`${unit.id} 生成/修复，第 ${state.attempts[unit.id]} 次`);
            const result = await options.generate(taskRoot, feedback);
            checkCancel();
            if (["model_error", "cancelled"].includes(result.status))
              throw Error(
                `${unit.id} 模型运行失败：${result.status}；候选与进度已保留`,
              );
            try {
              const files = await candidateFiles(taskRoot);
              const missing = spec.outputs.filter(
                (n) => !files.some((f) => f.name === n),
              );
              if (missing.length)
                throw Error(`缺少约定输出：${missing.join(", ")}`);
              const allowed = new Set([
                ...(task.writableFiles ?? []),
                ...(task.seedFiles ?? []).map((f) => f.name),
                "go.mod",
                "LICENSE",
                ...(sum ? ["go.sum"] : []),
              ]);
              if (files.some((f) => !allowed.has(f.name)))
                throw Error("候选有未授权输出");
              const report = await verifyPort(taskRoot, options.download);
              verification = await currentVerification(taskRoot);
              feedback =
                report.status === "behavior_verified"
                  ? undefined
                  : `上次验证失败：${report.status}。按verification.json修复，不修改冻结文件。`;
              log(`${unit.id} 验证：${report.status}`);
            } catch (e) {
              verification = undefined;
              feedback = e instanceof Error ? e.message : String(e);
              log(feedback);
            }
          }
          checkCancel();
          await ensureClean();
          if ((await inspectMigration(planRoot)).digest !== digest)
            throw Error("验收后迁移输入已变化，拒绝集成");
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
              throw Error(`集成拒绝覆盖已有文件：${f.name}`);
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
