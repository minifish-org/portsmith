import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, saveAnalysis } from "../src/analyze.js";
import { atomicJson, hash, snapshotFiles } from "../src/files.js";
import { migrate } from "../src/migrate.js";
import { loadTask, writeCandidate } from "../src/workspace.js";

const exec = promisify(execFile);
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const temp = await mkdtemp(path.join(tmpdir(), "portsmith-modules-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const project = path.join(temp, "project"),
    source = path.join(temp, "source"),
    plan = path.join(project, "migration");
  const put = async (p: string, s: string) => {
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, s);
  };
  await mkdir(project);
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: project })).stdout.trim();
  await git("init", "-q");
  await git("config", "user.name", "Module fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await put(path.join(project, "LICENSE"), "fixture\n");
  await git("add", "LICENSE");
  await git("commit", "-qm", "initial");
  await put(path.join(project, ".gitignore"), ".portsmith/\n");
  await put(
    path.join(project, "go.mod"),
    "module example.com/modules\n\ngo 1.24\n",
  );
  await put(path.join(source, "LICENSE"), "MIT fixture\n");
  await put(path.join(source, "value.ts"), "export const value=42;\n");
  await mkdir(plan);
  await saveAnalysis(await analyze(source), path.join(plan, "analysis.json"));
  await put(
    path.join(plan, "go.mod"),
    "module fixture.local/judges\n\ngo 1.24\n",
  );
  await put(path.join(plan, "RULEBOOK.md"), "Preserve fixture behavior\n");
  const outputs = {
    foundation: [
      "alpha/value.go",
      "alpha/value_test.go",
      "alpha/helper.go",
      "alpha/helper_test.go",
      "alpha/data.json",
    ],
    consumer: ["beta/value.go", "beta/value_test.go"],
  };
  const p = {
    version: 2,
    source,
    revision: "fixture",
    analysisSha256: hash(await readFile(path.join(plan, "analysis.json"))),
    modules: [
      { id: "ai", dependsOn: [], batches: ["foundation"] },
      { id: "core", dependsOn: ["ai"], batches: ["consumer"] },
    ],
    batches: Object.entries(outputs).map(([id, files]) => ({
      id,
      module: id === "foundation" ? "ai" : "core",
      dependsOn: [],
      sources: ["value.ts"],
      references: [],
      outputs: files,
      behaviors: ["preserve value"],
      acceptance: ["offline tests"],
    })),
  };
  await atomicJson(path.join(plan, "plan.json"), p);
  const spec = async (id: string, pkg: string, out: string[], expr: string) => {
    const name = "TestPortsmithJudge" + id;
    await put(
      path.join(plan, `${id}.md`),
      `${id}: Value() must return ${pkg === "alpha" ? 42 : 84}; candidate unit tests required`,
    );
    await put(
      path.join(plan, `judges/${id}/${pkg}/portsmith_judge_${id}_test.go`),
      `package ${pkg}\nimport "testing"\nfunc ${name}(t *testing.T){if ${expr}{t.Fatal("wrong behavior")}}\n`,
    );
    return {
      id,
      sources: ["value.ts"],
      goal: id,
      contract: `${id}.md`,
      judge: `judges/${id}`,
      outputs: out,
      tests: [name],
    };
  };
  const one = await spec(
    "First",
    "alpha",
    outputs.foundation.slice(0, 2),
    "Value()!=42",
  );
  const two = await spec(
    "Second",
    "alpha",
    outputs.foundation.slice(2),
    "helper()!=42",
  );
  const three = await spec("Third", "beta", outputs.consumer, "Value()!=84");
  const w = {
    version: 2,
    project: "..",
    runs: ".portsmith/runs",
    startPolicy: "available-steps",
    bootstrap: ["migration", "go.mod", ".gitignore"],
    batches: {
      foundation: {
        status: "partial",
        reason: "Second contract preparation pending",
        steps: [one],
      },
      consumer: { status: "ready", steps: [three] },
    },
  };
  const save = () => atomicJson(path.join(plan, "workflow.json"), w);
  await save();
  const ready = async () => {
    w.batches.foundation.status = "ready";
    w.batches.foundation.steps.push(two);
    await save();
  };
  const generate = async (root: string, wrong = false) => {
    const { task } = await loadTask(root);
    if (task.unit!.endsWith("/First")) {
      await writeCandidate(
        root,
        "alpha/value.go",
        "package alpha\nfunc Value() int {return 42}\n",
      );
      await writeCandidate(
        root,
        "alpha/value_test.go",
        'package alpha\nimport "testing"\nfunc TestValue(t *testing.T){if Value()<0{t.Fatal("negative")}}\n',
      );
    } else if (task.unit!.endsWith("/Second")) {
      await writeCandidate(
        root,
        "alpha/value.go",
        "package alpha\nfunc Value() int {return helper()}\n",
      );
      await writeCandidate(
        root,
        "alpha/helper.go",
        `package alpha\nfunc helper() int {return ${wrong ? 41 : 42}}\n`,
      );
      await writeCandidate(
        root,
        "alpha/helper_test.go",
        'package alpha\nimport "testing"\nfunc TestHelper(t *testing.T){if helper()<0{t.Fatal("negative")}}\n',
      );
      await writeCandidate(root, "alpha/data.json", '{"fixture":true}\n');
      await assert.rejects(
        writeCandidate(root, "alpha/unlisted.json", "{}"),
        /只能写|清单/,
      );
    } else {
      await assert.rejects(
        writeCandidate(
          root,
          "alpha/value.go",
          "package alpha\nfunc Value()int{return 0}\n",
        ),
        /清单|前置/,
      );
      assert.match(
        await readFile(path.join(root, "candidate/alpha/value.go"), "utf8"),
        /helper/,
      );
      await writeCandidate(
        root,
        "beta/value.go",
        'package beta\nimport "example.com/modules/alpha"\nfunc Value()int{return alpha.Value()*2}\n',
      );
      await writeCandidate(
        root,
        "beta/value_test.go",
        'package beta\nimport "testing"\nfunc TestValue(t *testing.T){if Value()<0{t.Fatal("negative")}}\n',
      );
    }
    return { status: "candidate_ready" };
  };
  return { project, plan, source, git, put, ready, generate };
}

test(
  "default migration continues beyond three failed generations without user intervention",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const result = await migrate({
      plan: f.plan,
      commit: true,
      generate: async (root) => {
        calls++;
        const result = await f.generate(root);
        if (calls <= 4)
          await writeCandidate(
            root,
            "alpha/value.go",
            "package alpha\nfunc Value() int {return missingValue}\n",
          );
        return result;
      },
    });
    assert.equal(calls, 5);
    assert.equal(result.status, "needs-preparation");
    const state = JSON.parse(
      await readFile(path.join(f.project, ".portsmith/modules.json"), "utf8"),
    );
    assert.equal(state.steps.length, 1);
  },
);

test(
  "repair limit shows compiler diagnostics and resumes the saved candidate",
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const root = path.join(
      await realpath(f.project),
      ".portsmith/runs/ai/foundation/First",
    );
    await assert.rejects(
      migrate({
        plan: f.plan,
        commit: true,
        maxAttempts: 1,
        generate: async (r) => {
          await f.generate(r);
          await writeCandidate(
            r,
            "alpha/value.go",
            "package alpha\nfunc Value() int {return missingValue}\n",
          );
          return { status: "candidate_ready" };
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /1 次生成\/修复上限/);
        assert.match(error.message, /compile_failed/);
        assert.match(
          error.message,
          /alpha\/value.go:\d+:\d+: undefined: missingValue/,
        );
        assert.ok(error.message.includes(path.join(root, "verification.json")));
        return true;
      },
    );
    const stateFile = path.join(f.project, ".portsmith/modules.json");
    const failed = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(failed.attempts["ai/foundation/First"], 1);
    assert.deepEqual(failed.steps, []);
    assert.match(
      await readFile(path.join(root, "candidate/alpha/value.go"), "utf8"),
      /missingValue/,
    );
    assert.doesNotMatch(await f.git("log", "--format=%s"), /feat: port/);
    let calls = 0;
    const resumed = await migrate({
      plan: f.plan,
      commit: true,
      maxAttempts: 1,
      generate: async (r) => {
        calls++;
        assert.equal(r, root);
        assert.match(
          await readFile(path.join(r, "candidate/alpha/value.go"), "utf8"),
          /missingValue/,
        );
        return f.generate(r);
      },
    });
    assert.equal(calls, 1);
    assert.equal(resumed.status, "needs-preparation");
    const passed = JSON.parse(await readFile(stateFile, "utf8"));
    assert.deepEqual(
      passed.steps.map((s: any) => s.key),
      ["ai/foundation/First"],
    );
    assert.equal(passed.attempts["ai/foundation/First"], 2);
  },
);

test("full migration checks every module before any model call or preparation commit", async (t) => {
  const f = await fixture(t);
  const workflowFile = path.join(f.plan, "workflow.json");
  const workflow = JSON.parse(await readFile(workflowFile, "utf8"));
  const consumer = workflow.batches.consumer;
  delete workflow.startPolicy; // Full preparation is the default, not an opt-in.
  workflow.batches.consumer = {
    status: "planned",
    reason: "Consumer judges pending",
    steps: [],
  };
  await atomicJson(workflowFile, workflow);
  const before = await f.git("status", "--porcelain");
  let calls = 0;
  const generate = async () => {
    calls++;
    throw Error("must not call model");
  };
  for (const check of [true, false]) {
    const report = await migrate({
      plan: f.plan,
      check,
      commit: !check,
      generate,
    });
    assert.equal(report.status, "needs-preparation");
    assert.ok("preparation" in report);
    assert.equal(report.canStart, false);
    assert.equal(report.preparation.ready, false);
    assert.equal(report.preparation.readyBatches, 0);
    assert.deepEqual(
      report.blocked.map((b) => b.module),
      ["ai", "core"],
    );
  }
  assert.equal(calls, 0);
  assert.equal(await f.git("status", "--porcelain"), before);
  assert.equal(await f.git("rev-list", "--count", "HEAD"), "1");
  await assert.rejects(
    readFile(path.join(f.project, ".portsmith/modules.json")),
    /ENOENT/,
  );

  await f.ready();
  const readyFoundation = JSON.parse(await readFile(workflowFile, "utf8"));
  workflow.batches.foundation = readyFoundation.batches.foundation;
  await atomicJson(workflowFile, workflow);
  const laterGap = await migrate({
    plan: f.plan,
    check: true,
    commit: false,
    generate,
  });
  assert.ok("preparation" in laterGap);
  assert.equal(laterGap.canStart, false); // Even a complete first module cannot hide later gaps.
  assert.equal(laterGap.preparation.readyBatches, 1);
  assert.deepEqual(
    laterGap.blocked.map((b) => b.module),
    ["core"],
  );

  await assert.rejects(
    exec(
      process.execPath,
      [
        "--import",
        "tsx",
        "--",
        "src/cli.ts",
        "migrate",
        "--plan",
        f.plan,
        "--commit",
        "--env-file",
        path.join(f.project, "missing.env"),
      ],
      { cwd: path.resolve(".") },
    ),
    (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string };
      assert.equal(result.code, 2, result.stderr);
      assert.equal(JSON.parse(result.stdout).canStart, false);
      return true;
    },
  );
  assert.equal(await f.git("rev-list", "--count", "HEAD"), "1");

  workflow.batches.consumer = consumer;
  await atomicJson(workflowFile, workflow);
  const ready = await migrate({
    plan: f.plan,
    check: true,
    commit: false,
    generate,
  });
  assert.ok("preparation" in ready);
  assert.equal(ready.status, "ready");
  assert.equal(ready.canStart, true);
  assert.equal(ready.preparation.readyBatches, 2);
  assert.deepEqual(ready.blocked, []);
  assert.equal(calls, 0);
});

test(
  "module checkpoints wait for preparation; resume permits same-module integration and commits exactly once per module",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const noModel = async () => {
      throw Error("must not call model");
    };
    const checked = await migrate({
      plan: f.plan,
      commit: false,
      check: true,
      generate: noModel,
    });
    assert.equal(checked.status, "partially-ready");
    assert.equal(await f.git("rev-list", "--count", "HEAD"), "1");
    let calls = 0;
    const first = await migrate({
      plan: f.plan,
      commit: true,
      generate: async (r) => {
        calls++;
        return f.generate(r);
      },
    });
    assert.equal(first.status, "needs-preparation");
    assert.equal(calls, 1);
    await assert.rejects(
      readFile(path.join(f.project, "alpha/value.go")),
      /ENOENT/,
    );
    assert.equal(
      (
        await migrate({
          plan: f.plan,
          commit: false,
          check: true,
          generate: noModel,
        })
      ).status,
      "needs-preparation",
    );
    await migrate({ plan: f.plan, commit: true, generate: noModel });
    await f.ready();
    let second = 0;
    const result = await migrate({
      plan: f.plan,
      commit: true,
      generate: async (r) => {
        calls++;
        if (r.endsWith("Second")) second++;
        return f.generate(r, second === 1 && r.endsWith("Second"));
      },
    });
    assert.equal(result.status, "complete");
    assert.equal(calls, 4);
    const commits = (await f.git("log", "--format=%s"))
      .split("\n")
      .filter((s) => s.startsWith("feat: port"));
    assert.deepEqual(commits, ["feat: port core", "feat: port ai"]);
    assert.equal(await f.git("status", "--porcelain"), "");
    assert.match(
      await readFile(path.join(f.project, "alpha/value.go"), "utf8"),
      /helper/,
    );
    assert.equal(
      (await migrate({ plan: f.plan, commit: true, generate: noModel })).status,
      "complete",
    );
    const journal = path.join(f.project, ".portsmith/modules.json"),
      state = JSON.parse(await readFile(journal, "utf8"));
    const done = state.modules.pop();
    const last = state.steps.at(-1);
    state.pending = {
      module: done.id,
      base: await f.git("rev-parse", "HEAD^"),
      files: done.files,
      message: await f.git("log", "-1", "--format=%B"),
      task: last.task,
      fingerprint: last.fingerprint,
      staging: ".portsmith/runs/core-integration",
    };
    await atomicJson(journal, state);
    await migrate({ plan: f.plan, commit: true, generate: noModel });
    assert.equal(
      (await f.git("log", "--format=%s"))
        .split("\n")
        .filter((s) => s.startsWith("feat: port")).length,
      2,
    );
    await f.put(path.join(f.plan, "First.md"), "altered contract");
    await assert.rejects(
      migrate({ plan: f.plan, commit: false, check: true, generate: noModel }),
      /已完成步骤/,
    );
  },
);

test(
  "module cancellation resumes a written candidate; failed commit preserves edits and recovers without regeneration",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    await f.ready();
    await f.put(path.join(f.project, "personal.txt"), "keep");
    await assert.rejects(
      migrate({ plan: f.plan, commit: true, generate: (r) => f.generate(r) }),
      /其他修改/,
    );
    assert.equal(await f.git("rev-list", "--count", "HEAD"), "1");
    await rm(path.join(f.project, "personal.txt"));
    const abort = new AbortController();
    await assert.rejects(
      migrate({
        plan: f.plan,
        commit: true,
        signal: abort.signal,
        generate: async (root) => {
          const r = await f.generate(root);
          abort.abort();
          return r;
        },
      }),
      /取消/,
    );
    const hook = path.join(f.project, ".git/hooks/pre-commit");
    await assert.rejects(
      migrate({
        plan: f.plan,
        commit: true,
        maxUnits: 1,
        generate: async (root) => {
          assert(
            !root.endsWith("First"),
            "completed candidate should verify without model",
          );
          const r = await f.generate(root);
          await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
          return r;
        },
      }),
    );
    const file = path.join(f.project, "alpha/value.go"),
      original = await readFile(file, "utf8");
    // Reproduce a pending transaction whose generated receipt exceeds the
    // source-file limit. Recovery must retain its exact bytes and hashes.
    const journal = path.join(f.project, ".portsmith/modules.json");
    const state = JSON.parse(await readFile(journal, "utf8"));
    const receiptName = `migration/results/${state.pending.module}.json`;
    const staging = path.join(f.project, state.pending.staging);
    const receiptPath = path.join(staging, receiptName);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    receipt.diagnosticLog = "x".repeat(1024 * 1024);
    await atomicJson(receiptPath, receipt);
    const receiptBytes = await readFile(receiptPath);
    state.pending.files.find(
      (entry: { name: string }) => entry.name === receiptName,
    ).sha256 = hash(receiptBytes);
    await atomicJson(journal, state);
    await writeFile(path.join(f.project, receiptName), receiptBytes);
    await assert.rejects(
      snapshotFiles(staging, 2000, 32 * 1024 * 1024, () => 512 * 1024),
      /文件太大/,
    );
    await f.put(file, original + "// user change\n");
    await rm(hook);
    const noModel = async () => {
      throw Error("no generation on commit recovery");
    };
    await assert.rejects(
      migrate({ plan: f.plan, commit: true, maxUnits: 1, generate: noModel }),
      /拒绝覆盖/,
    );
    await f.put(file, original);
    assert.equal(
      (
        await migrate({
          plan: f.plan,
          commit: true,
          maxUnits: 1,
          generate: noModel,
        })
      ).status,
      "paused-at-limit",
    );
    assert.equal(await f.git("status", "--porcelain"), "");
    assert.deepEqual(
      await readFile(path.join(f.project, receiptName)),
      receiptBytes,
    );
  },
);

test("v2 preflight rejects stale sources and missing judges before model calls or commits", async (t) => {
  const f = await fixture(t);
  const before = await f.git("rev-parse", "HEAD");
  const noModel = async () => {
    throw Error("no model in rejected preflight");
  };
  await f.put(path.join(f.source, "value.ts"), "export const value=43;\n");
  await assert.rejects(
    migrate({ plan: f.plan, commit: true, generate: noModel }),
    /源码在分析后变化/,
  );
  await f.put(path.join(f.source, "value.ts"), "export const value=42;\n");
  await f.put(
    path.join(f.plan, "judges/First/alpha/portsmith_judge_First_test.go"),
    "package alpha\n",
  );
  await assert.rejects(
    migrate({ plan: f.plan, commit: true, generate: noModel }),
    /独立测试缺失/,
  );
  assert.equal(await f.git("rev-parse", "HEAD"), before);
});

test("module runner reports output-limit details without discarding progress or retrying a fresh session", async (t) => {
  const f = await fixture(t);
  await f.ready();
  let calls = 0;
  await assert.rejects(
    migrate({
      plan: f.plan,
      commit: true,
      generate: async () => {
        calls++;
        return {
          status: "output_limit",
          error: "finish_reason=length; configured output 32768",
        };
      },
    }),
    (error) => {
      assert.match(String(error), /finish_reason=length/);
      assert.match(String(error), /32768/);
      assert.match(String(error), /last-run.json/);
      return true;
    },
  );
  assert.equal(calls, 1);
  const state = JSON.parse(
    await readFile(path.join(f.project, ".portsmith/modules.json"), "utf8"),
  );
  assert.equal(state.attempts["ai/foundation/First"], 1);
  assert.equal(state.modules.length, 0);
  assert.equal(
    (
      await migrate({
        plan: f.plan,
        check: true,
        commit: false,
        generate: async () => {
          throw Error("no model");
        },
      })
    ).status,
    "ready",
  );
});

test(
  "frozen assets survive module integration and commits, reject writes and detect changed hashes",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    await f.ready();
    const workflowFile = path.join(f.plan, "workflow.json"),
      planFile = path.join(f.plan, "plan.json");
    const w = JSON.parse(await readFile(workflowFile, "utf8")),
      p = JSON.parse(await readFile(planFile, "utf8"));
    const name = "alpha/frozen.json",
      data = '{"catalog":42}\n';
    await f.put(path.join(f.plan, "catalog.json"), data);
    p.batches[0].outputs.push(name);
    w.batches.foundation.steps[0].assets = [
      { source: "catalog.json", target: name, sha256: hash(data) },
    ];
    await atomicJson(planFile, p);
    await atomicJson(workflowFile, w);
    const check = () =>
      migrate({
        plan: f.plan,
        check: true,
        commit: false,
        generate: async () => {
          throw Error("no model");
        },
      });
    await f.put(path.join(f.plan, "catalog.json"), data + " ");
    await assert.rejects(check, /静态资产变更/);
    await f.put(path.join(f.plan, "catalog.json"), data);
    w.batches.foundation.steps[1].outputs.push(name);
    await atomicJson(workflowFile, w);
    await assert.rejects(check, /静态资产不可声明/);
    w.batches.foundation.steps[1].outputs.pop();
    await atomicJson(workflowFile, w);
    let steps = 0;
    const report = await migrate({
      plan: f.plan,
      commit: true,
      generate: async (root) => {
        steps++;
        assert.equal(
          await readFile(path.join(root, "candidate", name), "utf8"),
          data,
        );
        await assert.rejects(
          writeCandidate(root, name, "{}"),
          /前置|清单|只能写/,
        );
        return f.generate(root);
      },
    });
    assert.equal(report.status, "complete");
    assert.equal(steps, 3);
    assert.equal(await readFile(path.join(f.project, name), "utf8"), data);
    assert.equal(await f.git("status", "--porcelain"), "");
  },
);
