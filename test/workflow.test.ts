import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, saveAnalysis } from "../src/analyze.js";
import { createPlan, packageCycles, selectUnit } from "../src/plan.js";
import { atomicJson, withLock } from "../src/files.js";
import {
  prepareTask,
  writeCandidate,
  loadTask,
  editCandidate,
} from "../src/workspace.js";
import { verifyPort } from "../src/verify.js";
import { acceptTask, taskStatus, planStatus } from "../src/state.js";
import { execute } from "../src/process.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "portsmith-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source");
  await mkdir(source);
  await writeFile(path.join(source, "LICENSE"), "MIT test fixture\n");
  const put = async (name: string, text: string) => {
    const f = path.join(source, name);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, text);
  };
  return { dir, source, put };
}
test("TS parser resolves .js imports, aliases, export/import types, cycles; ignores comment imports", async (t) => {
  const { source, put } = await fixture(t);
  await put(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@lib/*": ["lib/*"] } },
    }),
  );
  await put("package.json", JSON.stringify({ name: "@local/project" }));
  await put(
    "main.ts",
    `import {a} from '@lib/a.js';\nexport {b} from './lib/b.js';\n// import 'fake'\nconst s="import x from 'fake2'";\nimport('@local/project/missing');\nimport('./missing.js');\nimport(variable);\nimport type {Stats} from 'node:fs';\ntype T=import('./lib/b.js').B;`,
  );
  await put("lib/a.ts", "import './b.js'; export const a=1;");
  await put(
    "lib/b.ts",
    "import './a.js'; export const b=2; export type B=number;",
  );
  const report = await analyze(source);
  const edges = report.files.find((f) => f.path === "main.ts")!.imports;
  assert.equal(edges.filter((e) => e.kind === "internal").length, 3);
  assert.equal(edges.filter((e) => e.kind === "unresolved").length, 2);
  assert.equal(edges.filter((e) => e.kind === "computed").length, 1);
  assert.equal(edges.filter((e) => e.kind === "external").length, 1);
  assert.deepEqual(report.cycles, [["lib/a.ts", "lib/b.ts"]]);
  assert.ok(!edges.some((e) => e.specifier.startsWith("fake")));
});
test("a clean file graph can still produce a cyclic Go package graph", async (t) => {
  const { source, dir, put } = await fixture(t);
  await put("a/one.ts", "import '../b/one.js';");
  await put("b/one.ts", "export const a=1;");
  await put("b/two.ts", "import '../a/two.js';");
  await put("a/two.ts", "export const b=2;");
  const report = await analyze(source);
  assert.equal(report.cycles.length, 0);
  const file = path.join(dir, "analysis.json");
  await saveAnalysis(report, file);
  const plan = await createPlan(file, path.join(dir, "plan"), "test");
  assert.equal(packageCycles(plan.units).length, 1);
});
test("catch-all paths and node_modules aliases do not turn external packages into missing internal files", async (t) => {
  const { source, put } = await fixture(t);
  await put(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        baseUrl: ".",
        paths: {
          "*": ["./*"],
          typebox: ["./node_modules/typebox"],
          "@local/*": ["./src/*"],
        },
      },
    }),
  );
  await put(
    "main.ts",
    "import 'node:fs'; import 'vitest'; import 'typebox'; import '@local/missing'; import 'helper';",
  );
  await put("helper.ts", "export const value=1;");
  const report = await analyze(source),
    edges = report.files.find((f) => f.path === "main.ts")!.imports;
  assert.deepEqual(
    edges.filter((e) => e.kind === "external").map((e) => e.specifier),
    ["node:fs", "vitest", "typebox"],
  );
  assert.deepEqual(
    edges.filter((e) => e.kind === "unresolved").map((e) => e.specifier),
    ["@local/missing"],
  );
  assert.equal(
    edges.find((e) => e.specifier === "helper")?.target,
    "helper.ts",
  );
});
test("plan requires acceptance and detects source/config drift", async (t) => {
  const { source, dir, put } = await fixture(t);
  await put("main.ts", "export const answer=42;");
  await put("tsconfig.json", "{}");
  const report = await analyze(source);
  const file = path.join(dir, "analysis.json");
  await saveAnalysis(report, file);
  const root = path.join(dir, "plan");
  const plan = await createPlan(file, root, "fixture");
  await assert.rejects(selectUnit(root, "root"), /acceptance/);
  plan.units[0].acceptance = ["answer=42"];
  await atomicJson(path.join(root, "plan.json"), plan);
  await selectUnit(root, "root");
  await put("main.ts", "export const answer=43;");
  await assert.rejects(selectUnit(root, "root"), /源码/);
  await put("main.ts", "export const answer=42;");
  await put("tsconfig.json", '{"compilerOptions":{}}');
  await assert.rejects(selectUnit(root, "root"), /配置/);
});
test("locking prevents concurrent mutation and releases on failure", async (t) => {
  const { dir } = await fixture(t);
  await assert.rejects(
    withLock(dir, async () => {
      await assert.rejects(
        withLock(dir, async () => {}),
        /正在运行/,
      );
      throw Error("deliberate");
    }),
    /deliberate/,
  );
  await withLock(dir, async () => {});
});
test("precise edits preserve the file and reject ambiguous matches, fragments and control files", async (t) => {
  const { dir, source, put } = await fixture(t);
  await put("unit.ts", "export const answer=42;");
  const root = await prepareTask({
    source,
    out: path.join(dir, "task"),
    revision: "test",
    files: ["unit.ts"],
    goal: "constant",
  });
  await writeCandidate(
    root,
    "unit.go",
    "package port\nconst Answer=41\n// keep this\n",
  );
  await editCandidate(root, "unit.go", "Answer=41", "Answer=42");
  assert.equal(
    await readFile(path.join(root, "candidate/unit.go"), "utf8"),
    "package port\nconst Answer=42\n// keep this\n",
  );
  await assert.rejects(
    editCandidate(root, "unit.go", " ", "x"),
    /精确出现一次/,
  );
  await assert.rejects(editCandidate(root, "go.mod", "1.24", "1.25"), /只能写/);
  await assert.rejects(
    writeCandidate(root, "unit.go", "const Answer=99\n"),
    /完整文件/,
  );
});
test("plan edits invalidate previous task associations and keep dependents blocked", async (t) => {
  const { dir, source, put } = await fixture(t);
  await put("main.ts", "export const answer=42;");
  const analysis = path.join(dir, "analysis.json");
  await saveAnalysis(await analyze(source), analysis);
  const root = path.join(dir, "plan");
  const plan = await createPlan(analysis, root, "test");
  plan.units[0].acceptance = ["answer=42"];
  await atomicJson(path.join(root, "plan.json"), plan);
  const selected = await selectUnit(root, "root");
  const runs = path.join(dir, "runs");
  await prepareTask({
    source,
    out: path.join(runs, "root"),
    revision: "test",
    files: ["main.ts"],
    goal: "answer",
    unit: "root",
    planDigest: selected.planDigest,
  });
  assert.equal((await planStatus(root, runs))[0].state, "prepared");
  plan.units[0].goal = "changed scope";
  await atomicJson(path.join(root, "plan.json"), plan);
  assert.equal((await planStatus(root, runs))[0].state, "plan_changed");
});
test("process runner enforces timeouts without passing provider credentials", async (t) => {
  const { dir } = await fixture(t);
  process.env.PORTSMITH_TEST_SECRET = "private";
  const run = await execute(
    process.execPath,
    ["-e", "console.log(process.env.PORTSMITH_TEST_SECRET ?? 'absent')"],
    dir,
  );
  delete process.env.PORTSMITH_TEST_SECRET;
  assert.equal(run.log.trim(), "absent");
  const timeout = await execute(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    dir,
    100,
  );
  assert.equal(timeout.timedOut, true);
});
test(
  "independent judge gates acceptance; edits invalidate receipts; replay cannot overwrite export",
  { timeout: 60000 },
  async (t) => {
    const { dir, source, put } = await fixture(t);
    await put("unit.ts", "export const answer=42;");
    const judge = path.join(dir, "judge");
    await mkdir(judge);
    await writeFile(
      path.join(judge, "judge_test.go"),
      'package port\nimport "testing"\nfunc TestPortsmithJudgeAnswer(t *testing.T){if Answer!=42{t.Fatal(Answer)}}\n',
    );
    const root = await prepareTask({
      source,
      out: path.join(dir, "task"),
      revision: "fixture",
      files: ["unit.ts"],
      goal: "port answer",
      judge,
    });
    await writeCandidate(root, "answer.go", "package port\nconst Answer=42\n");
    await writeCandidate(
      root,
      "answer_test.go",
      'package port\nimport "testing"\nfunc TestAnswer(t *testing.T){if Answer<0{t.Fatal(Answer)}}\n',
    );
    await assert.rejects(
      writeCandidate(root, "judge_test.go", "bad"),
      /独立验证器/,
    );
    assert.equal((await verifyPort(root)).status, "behavior_verified");
    const out = path.join(dir, "accepted");
    await acceptTask(root, out);
    assert.equal((await taskStatus(root)).state, "accepted");
    await assert.rejects(acceptTask(root, out), /exist/);
    await writeFile(path.join(out, "answer.go"), "changed");
    assert.equal((await taskStatus(root)).state, "export_changed");
    await writeCandidate(root, "answer.go", "package port\nconst Answer=41\n");
    assert.equal((await taskStatus(root)).state, "stale_verification");
    await assert.rejects(
      acceptTask(root, path.join(dir, "bad-export")),
      /独立行为验证/,
    );
    assert.equal((await verifyPort(root)).status, "behavior_failed");
    await writeFile(path.join(root, "judge/judge_test.go"), "tampered");
    await assert.rejects(loadTask(root), /judge发生变化/);
  },
);
test(
  "self-tests alone cannot establish behavior parity; empty/skipped judges are rejected",
  { timeout: 60000 },
  async (t) => {
    const { dir, source, put } = await fixture(t);
    await put("unit.ts", "export const answer=42;");
    const root = await prepareTask({
      source,
      out: path.join(dir, "task"),
      revision: "test",
      files: ["unit.ts"],
      goal: "constant",
    });
    await writeCandidate(root, "answer.go", "package port\nconst Answer=42\n");
    await writeCandidate(
      root,
      "answer_test.go",
      'package port\nimport "testing"\nfunc TestAnswer(t *testing.T){}\n',
    );
    assert.equal((await verifyPort(root)).status, "tests_passed");
    await assert.rejects(
      acceptTask(root, path.join(dir, "out")),
      /独立行为验证/,
    );
    const judge = path.join(dir, "judge");
    await mkdir(judge);
    await writeFile(
      path.join(judge, "judge_test.go"),
      'package port\nimport "testing"\nfunc TestPortsmithJudgeSkipped(t *testing.T){t.Skip("not implemented")}\n',
    );
    const second = await prepareTask({
      source,
      out: path.join(dir, "task2"),
      revision: "test",
      files: ["unit.ts"],
      goal: "constant",
      judge,
    });
    for (const name of ["answer.go", "answer_test.go"])
      await writeCandidate(
        second,
        name,
        await readFile(path.join(root, "candidate", name), "utf8"),
      );
    assert.equal((await verifyPort(second)).status, "behavior_failed");
    await writeFile(
      path.join(judge, "judge_test.go"),
      'package port\nimport "testing"\nfunc TestOther(t *testing.T){}\n',
    );
    const third = await prepareTask({
      source,
      out: path.join(dir, "task3"),
      revision: "test",
      files: ["unit.ts"],
      goal: "constant",
      judge,
    });
    for (const name of ["answer.go", "answer_test.go"])
      await writeCandidate(
        third,
        name,
        await readFile(path.join(root, "candidate", name), "utf8"),
      );
    assert.equal((await verifyPort(third)).status, "behavior_failed");
    await writeCandidate(
      third,
      "pretend_test.go",
      'package port\nimport "testing"\nfunc TestPortsmithJudgePretend(t *testing.T){}\n',
    );
    await assert.rejects(verifyPort(third), /保留测试名前缀/);
  },
);
test("approved dependency manifests are frozen and local replacements are rejected", async (t) => {
  const { dir, source, put } = await fixture(t);
  await put("unit.ts", "export const answer=42;");
  const mod = path.join(dir, "go.mod");
  await writeFile(
    mod,
    "module example.com/test\n\ngo 1.24\n\nrequire github.com/google/uuid v1.6.0\n",
  );
  const sum = path.join(dir, "go.sum");
  await writeFile(sum, "");
  const root = await prepareTask({
    source,
    out: path.join(dir, "task"),
    revision: "test",
    files: ["unit.ts"],
    goal: "x",
    goMod: mod,
    goSum: sum,
  });
  await loadTask(root);
  await writeFile(path.join(root, "candidate/go.mod"), "module changed\n");
  await assert.rejects(loadTask(root), /冻结配置/);
  await writeFile(
    mod,
    "module example.com/test\nreplace example.com/secret => ../secret\n",
  );
  await assert.rejects(
    prepareTask({
      source,
      out: path.join(dir, "bad"),
      revision: "test",
      files: ["unit.ts"],
      goal: "x",
      goMod: mod,
    }),
    /本地 replace/,
  );
});

test(
  "required named judge cases cannot be replaced by a single passing test",
  { timeout: 60000 },
  async (t) => {
    const { dir, source, put } = await fixture(t);
    await put("unit.ts", "export const answer=42;");
    const root = await prepareTask({
      source,
      out: path.join(dir, "task"),
      revision: "fixture",
      files: ["unit.ts"],
      goal: "answer",
      requiredJudgeTests: [
        "TestPortsmithJudgePresent",
        "TestPortsmithJudgeMissing",
      ],
      judgeFiles: [
        {
          name: "judge_test.go",
          data: Buffer.from(
            'package port\nimport "testing"\nfunc TestPortsmithJudgePresent(t *testing.T){if Answer!=42{t.Fatal(Answer)}}\n',
          ),
        },
      ],
    });
    await writeCandidate(root, "answer.go", "package port\nconst Answer=42\n");
    await writeCandidate(
      root,
      "answer_test.go",
      'package port\nimport "testing"\nfunc TestCandidate(t *testing.T){}\n',
    );
    assert.equal((await verifyPort(root)).status, "behavior_failed");
  },
);
