import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyze, saveAnalysis } from "../src/analyze.js";
import { createPlan } from "../src/plan.js";
import { migrate } from "../src/migrate.js";
import { loadTask, writeCandidate } from "../src/workspace.js";
import { atomicJson } from "../src/files.js";

const exec = promisify(execFile);
async function fixture(t: { after: (f: () => Promise<void>) => void }) {
  const dir = await mkdtemp(path.join(tmpdir(), "portsmith-pipeline-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, "target"),
    source = path.join(dir, "source"),
    plan = path.join(project, "migration");
  const put = async (name: string, text: string) => {
    await mkdir(path.dirname(name), { recursive: true });
    await writeFile(name, text);
  };
  const git = async (...args: string[]) =>
    (await exec("git", args, { cwd: project })).stdout.trim();
  await mkdir(project);
  await git("init", "-q");
  await git("config", "user.name", "Pipeline fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await put(path.join(project, "LICENSE"), "fixture license\n");
  await git("add", "LICENSE");
  await git("commit", "-qm", "initial");
  await put(path.join(project, ".gitignore"), ".portsmith/\n");
  await put(
    path.join(project, "go.mod"),
    "module example.com/pipeline\n\ngo 1.24\n",
  );
  await put(path.join(source, "LICENSE"), "MIT fixture\n");
  await put(path.join(source, "alpha/value.ts"), "export const value=42;\n");
  await put(
    path.join(source, "beta/value.ts"),
    "import {value} from '../alpha/value.ts'; export const twice=value*2;\n",
  );
  const analysis = path.join(dir, "analysis.json");
  await saveAnalysis(await analyze(source), analysis);
  const p = await createPlan(analysis, plan, "fixture");
  for (const u of p.units) {
    u.acceptance = [u.id + " returns expected value"];
    u.goal = u.acceptance[0];
  }
  await atomicJson(path.join(plan, "plan.json"), p);
  await put(
    path.join(plan, "go.mod"),
    "module example.com/fixtures\n\ngo 1.24\n",
  );
  const units: Record<string, unknown> = {};
  for (const id of ["alpha", "beta"]) {
    const testName = "TestPortsmithJudge" + id;
    const code = id === "alpha" ? "Value != 42" : "Value() != 84";
    await put(
      path.join(plan, `judges/${id}/${id}/portsmith_judge_test.go`),
      `package ${id}\nimport "testing"\nfunc ${testName}(t *testing.T){if ${code}{t.Fatal("incorrect behavior")}}\n`,
    );
    await put(path.join(plan, `${id}.md`), id + " API fixed by test fixture");
    units[id] = {
      contract: `${id}.md`,
      judge: `judges/${id}`,
      outputs: [`${id}/value.go`, `${id}/value_test.go`],
      tests: [testName],
    };
  }
  await atomicJson(path.join(plan, "workflow.json"), {
    version: 1,
    project: "..",
    runs: ".portsmith/tasks",
    bootstrap: [".gitignore", "go.mod", "migration"],
    units,
  });
  const generate = async (root: string, value = 42) => {
    const { task } = await loadTask(root);
    const id = task.unit!;
    if (id === "beta") {
      await assert.rejects(
        writeCandidate(
          root,
          "alpha/value.go",
          "package alpha\nconst Value=99\n",
        ),
        /writable|seed/,
      );
      assert.match(
        await readFile(path.join(root, "candidate/alpha/value.go"), "utf8"),
        /42/,
      );
    }
    const body =
      id === "alpha"
        ? `const Value=${value}`
        : 'import "example.com/pipeline/alpha"\nfunc Value()int{return alpha.Value*2}';
    await writeCandidate(root, `${id}/value.go`, `package ${id}\n${body}\n`);
    await writeCandidate(
      root,
      `${id}/value_test.go`,
      `package ${id}\nimport "testing"\nfunc TestCandidate(t *testing.T){if ${id === "alpha" ? "Value" : "Value()"}<0{t.Fatal("negative")}}\n`,
    );
    return { status: "candidate_ready" };
  };
  return { dir, project, plan, git, put, generate };
}

test(
  "pipeline checks all judges before any model or commit, then sequences repair, cumulative verification and per-unit commits",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const before = await f.git("rev-parse", "HEAD");
    const ready = await migrate({
      plan: f.plan,
      commit: false,
      check: true,
      generate: async () => {
        throw Error("no model during check");
      },
    });
    assert.equal(ready.status, "ready");
    assert.equal(await f.git("rev-parse", "HEAD"), before);
    let calls = 0;
    const result = await migrate({
      plan: f.plan,
      commit: true,
      generate: async (root) => {
        calls++;
        return f.generate(root, calls === 1 ? 41 : 42);
      },
    });
    assert.equal(result.status, "complete");
    assert.equal(calls, 3);
    assert.equal(await f.git("rev-list", "--count", "HEAD"), "4"); // initial, setup, alpha, beta
    assert.equal(await f.git("status", "--porcelain"), "");
    assert.match(await f.git("log", "-1", "--format=%B"), /port beta/);
    assert.match(
      await readFile(
        path.join(f.project, "migration/results/beta.json"),
        "utf8",
      ),
      /behavior_verified/,
    );
    const again = await migrate({
      plan: f.plan,
      commit: true,
      generate: async () => {
        throw Error("already complete");
      },
    });
    assert.equal(again.status, "complete");
    assert.equal(await f.git("rev-list", "--count", "HEAD"), "4");
    // Simulate power loss after git commit but before saving the completion receipt.
    const journal = path.join(f.project, ".portsmith/migrate.json");
    const state = JSON.parse(await readFile(journal, "utf8"));
    const last = state.completed.pop();
    state.pending = {
      id: last.id,
      files: last.files,
      base: await f.git("rev-parse", "HEAD^"),
      message: await f.git("log", "-1", "--format=%B"),
      fingerprint: "unused in committed recovery",
    };
    await atomicJson(journal, state);
    await migrate({
      plan: f.plan,
      commit: true,
      generate: async () => {
        throw Error("no duplicate model");
      },
    });
    assert.equal(await f.git("rev-list", "--count", "HEAD"), "4");
  },
);
test(
  "pipeline stops at retry bound and resumes same task; unrelated changes and missing tests block before work",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    await f.put(path.join(f.project, "personal.txt"), "keep");
    await assert.rejects(
      migrate({
        plan: f.plan,
        commit: true,
        generate: (root) => f.generate(root),
      }),
      /resolve these changes/,
    );
    assert.equal(await f.git("rev-list", "--count", "HEAD"), "1");
    await rm(path.join(f.project, "personal.txt"));
    let calls = 0;
    await assert.rejects(
      migrate({
        plan: f.plan,
        commit: true,
        maxAttempts: 2,
        generate: async (root) => {
          calls++;
          return f.generate(root, 41);
        },
      }),
      /limit/,
    );
    assert.equal(calls, 2);
    assert.equal(await f.git("rev-list", "--count", "HEAD"), "2");
    await migrate({
      plan: f.plan,
      commit: true,
      maxUnits: 1,
      generate: (root) => f.generate(root),
    });
    assert.equal(await f.git("rev-list", "--count", "HEAD"), "3");
    const file = path.join(f.plan, "judges/beta/beta/portsmith_judge_test.go");
    await f.put(file, "package beta\n");
    await assert.rejects(
      migrate({
        plan: f.plan,
        commit: true,
        generate: async () => {
          throw Error("must preflight");
        },
      }),
      /Missing independent tests/,
    );
  },
);
test(
  "pipeline preserves cancelled candidate and recovers a failed commit without regeneration",
  { timeout: 120000 },
  async (t) => {
    const f = await fixture(t);
    const abort = new AbortController();
    await assert.rejects(
      migrate({
        plan: f.plan,
        commit: true,
        signal: abort.signal,
        generate: async (root) => {
          await f.generate(root);
          abort.abort();
          return { status: "cancelled" };
        },
      }),
      /cancelled/,
    );
    const hook = path.join(f.project, ".git/hooks/pre-commit");
    await assert.rejects(
      migrate({
        plan: f.plan,
        commit: true,
        maxUnits: 1,
        generate: async (root) => {
          const result = await f.generate(root);
          await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
          return result;
        },
      }),
    );
    const state = JSON.parse(
      await readFile(path.join(f.project, ".portsmith/migrate.json"), "utf8"),
    );
    assert.equal(state.pending.id, "alpha");
    const installed = await readFile(
      path.join(f.project, "alpha/value.go"),
      "utf8",
    );
    await f.put(
      path.join(f.project, "alpha/value.go"),
      installed + "// user change\n",
    );
    await rm(hook);
    await assert.rejects(
      migrate({
        plan: f.plan,
        commit: true,
        generate: (root) => f.generate(root),
      }),
      /refuses to overwrite/,
    );
    await f.put(path.join(f.project, "alpha/value.go"), installed);
    const resumed = await migrate({
      plan: f.plan,
      commit: true,
      maxUnits: 1,
      generate: async () => {
        throw Error("should only recover alpha");
      },
    });
    assert.equal(resumed.status, "paused-at-limit");
    assert.equal(await f.git("status", "--porcelain"), "");
  },
);
