import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { analyze, saveAnalysis } from "./analyze.js";
import { createPlan, selectUnit } from "./plan.js";
import { prepareTask, EVENT_GOAL } from "./workspace.js";
import { withLock } from "./files.js";
import { runPort } from "./agent.js";
import { configuredModel, loadLocalEnv } from "./model.js";
import { judgeCheck, verifyPort } from "./verify.js";
import { acceptTask, planStatus, taskStatus } from "./state.js";
import { migrate } from "./migrate.js";

const help = `Portsmith — an inspectable, resumable TypeScript-to-Go migration workbench

portsmith analyze --source <source> --out <analysis.json>
portsmith migrate --plan <plan-directory> --check
portsmith migrate --plan <plan-directory> --commit [--env-file <file>] [--max-attempts 0] [--max-units 1]
portsmith plan --analysis <analysis.json> --out <plan-directory> --revision <revision>
portsmith prepare --plan <plan-directory> --unit <unit-id> --out <task-directory>
portsmith prepare --source <source> --out <task-directory> --revision <revision>
                  --file <relative-file> [--file <test>] --goal <goal>
portsmith prepare --source <pi-source> --out <task-directory> --revision <revision> --example event-stream
portsmith run --task <task-directory> [--env-file <file>] [--feedback <review.md>] [--max-turns <turns>] [--timeout <seconds>]
portsmith judge-check --task <task-directory>
portsmith verify --task <task-directory> [--allow-download]
portsmith status --task <task-directory>
portsmith status --plan <plan-directory> --runs <runs-directory>
portsmith next --plan <plan-directory> --runs <runs-directory>
portsmith accept --task <task-directory> --out <new-export-directory>

prepare options: --rules <rules.md> --go-mod <go.mod> --go-sum <go.sum> --judge <judge-directory>
Uses Pi Coding Agent's native tools, persistent sessions, skills and extensions. Local execution is not an OS sandbox.
Default: unlimited model turns, repair attempts and runtime. Positive --max-turns / --max-attempts / --timeout values set budgets; 0 disables them. Ctrl-C preserves progress.
Mature Go dependencies are allowed. Manifests are frozen; --allow-download permits verifier dependency downloads.
analyze/plan do not call models. Review and complete acceptance contracts before execution. No automatic push or publication.
Revision labels are user-supplied; selected files are checked by SHA-256, not authenticated as a Git identity.
v2 requires all batches prepared before starting. needs-preparation reports gaps before model calls. --max-units counts complete modules.
`;
export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "-h") {
    console.log(help);
    return;
  }
  const { values: v } = parseArgs({
    args: rest,
    options: {
      source: { type: "string" },
      out: { type: "string" },
      analysis: { type: "string" },
      revision: { type: "string" },
      plan: { type: "string" },
      unit: { type: "string" },
      runs: { type: "string" },
      file: { type: "string", multiple: true },
      goal: { type: "string" },
      example: { type: "string" },
      rules: { type: "string" },
      "go-mod": { type: "string" },
      "go-sum": { type: "string" },
      judge: { type: "string" },
      task: { type: "string" },
      "env-file": { type: "string" },
      feedback: { type: "string" },
      "max-turns": { type: "string", default: "0" },
      timeout: { type: "string", default: "0" },
      "allow-download": { type: "boolean" },
      check: { type: "boolean" },
      commit: { type: "boolean" },
      "max-attempts": { type: "string", default: "0" },
      "max-units": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (v.help) {
    console.log(help);
    return;
  }
  const req = (name: keyof typeof v) => {
    const value = v[name];
    if (typeof value !== "string" || !value) throw new Error(`缺少--${name}`);
    return value;
  };
  if (command === "migrate") {
    const maxTurns = Number(v["max-turns"]),
      timeout = Number(v.timeout);
    if (
      !Number.isSafeInteger(maxTurns) ||
      maxTurns < 0 ||
      !Number.isSafeInteger(timeout) ||
      timeout < 0 ||
      timeout * 1000 > 2147483647
    )
      throw Error(
        "max-turns必须为非负整数；timeout必须为0–2147483秒；0表示不限制",
      );
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    let connection: Awaited<ReturnType<typeof configuredModel>> | undefined;
    try {
      const result = await migrate({
        plan: req("plan"),
        commit: v.commit ?? false,
        check: v.check,
        maxAttempts: Number(v["max-attempts"]),
        maxUnits: v["max-units"] ? Number(v["max-units"]) : undefined,
        download: v["allow-download"],
        signal: controller.signal,
        onProgress: console.log,
        generate: async (root, feedback) => {
          if (!connection) {
            loadLocalEnv(v["env-file"]);
            connection = await configuredModel();
            console.log(
              `模型：${connection.model.id}；单次输出上限：${connection.model.maxTokens} tokens；工作上下文：${connection.model.contextWindow} tokens`,
            );
          }
          return runPort({
            root,
            ...connection,
            maxTurns,
            timeoutMs: timeout * 1000,
            download: v["allow-download"],
            signal: controller.signal,
            feedback,
            onProgress: console.log,
          });
        },
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.status === "needs-preparation") process.exitCode = 2;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
    return;
  }
  if (command === "analyze") {
    const report = await analyze(req("source"));
    await saveAnalysis(report, req("out"));
    const imports = report.files.flatMap((f) => f.imports);
    console.log(
      JSON.stringify(
        {
          files: report.files.length,
          lines: report.files.reduce((n, f) => n + f.lines, 0),
          cycles: report.cycles.length,
          unresolved: imports.filter((e) =>
            ["unresolved", "computed"].includes(e.kind),
          ).length,
          warnings: report.warnings,
          out: path.resolve(req("out")),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "plan") {
    const plan = await createPlan(req("analysis"), req("out"), req("revision"));
    console.log(
      `已生成${plan.units.length}个草稿任务，${plan.packageCycles.length}个包循环。请编辑plan.json的goal、targetPackage、acceptance和依赖。`,
    );
    return;
  }
  if (command === "prepare") {
    if (v.example && v.example !== "event-stream")
      throw new Error("内置示例只有event-stream");
    const common = {
      out: req("out"),
      rules: v.rules,
      goMod: v["go-mod"],
      goSum: v["go-sum"],
      judge: v.judge,
    };
    let root: string;
    if (v.plan) {
      const { plan, unit, planDigest } = await selectUnit(v.plan, req("unit"));
      root = await prepareTask({
        ...common,
        source: plan.source,
        revision: plan.revision,
        files: [...unit.files, ...unit.references],
        goal:
          unit.goal +
          "\n验收：\n" +
          unit.acceptance.join("\n") +
          "\nGo目标包：" +
          unit.targetPackage,
        rules: v.rules ?? path.join(v.plan, "RULEBOOK.md"),
        unit: unit.id,
        dependsOn: unit.dependsOn,
        planDigest,
      });
    } else {
      const example = v.example as "event-stream" | undefined;
      root = await prepareTask({
        ...common,
        source: req("source"),
        revision: req("revision"),
        files: example
          ? [
              "packages/ai/src/utils/event-stream.ts",
              "packages/ai/test/event-stream.test.ts",
            ]
          : (v.file ?? []),
        goal: example ? EVENT_GOAL : req("goal"),
        example,
      });
    }
    console.log(`任务快照已创建：${root}`);
    return;
  }
  if (command === "status" || command === "next") {
    if (v.task) {
      console.log(JSON.stringify(await taskStatus(v.task), null, 2));
      return;
    }
    const states = await planStatus(req("plan"), req("runs"));
    console.log(
      JSON.stringify(
        command === "next"
          ? states.filter(
              (s) =>
                !s.blockedBy.length &&
                !["behavior_verified", "accepted"].includes(s.state),
            )
          : states,
        null,
        2,
      ),
    );
    return;
  }
  const root = path.resolve(req("task"));
  await withLock(root, async () => {
    if (command === "judge-check") {
      console.log(JSON.stringify(await judgeCheck(root), null, 2));
      return;
    }
    if (command === "verify") {
      const report = await verifyPort(root, v["allow-download"]);
      for (const phase of report.phases) {
        console.log(
          `${phase.name}: ${phase.result.code === 0 ? "通过" : "失败"}`,
        );
        if (phase.result.code !== 0)
          console.log(phase.result.log.slice(-12000));
      }
      console.log(
        `${report.status} · ${report.oracleCases}个内置对照场景；不是完整兼容证明`,
      );
      if (!["tests_passed", "behavior_verified"].includes(report.status))
        process.exitCode = 1;
      return;
    }
    if (command === "accept") {
      console.log(`已导出：${await acceptTask(root, req("out"))}`);
      return;
    }
    if (command !== "run") throw new Error(`未知命令：${command}`);
    const maxTurns = Number(v["max-turns"]),
      timeout = Number(v.timeout);
    if (
      !Number.isSafeInteger(maxTurns) ||
      maxTurns < 0 ||
      !Number.isSafeInteger(timeout) ||
      timeout < 0 ||
      timeout * 1000 > 2147483647
    )
      throw new Error(
        "max-turns必须为非负整数；timeout必须为0–2147483秒；0表示不限制",
      );
    const feedback = v.feedback
      ? await readFile(v.feedback, "utf8")
      : undefined;
    loadLocalEnv(v["env-file"]);
    const { runtime, model } = await configuredModel();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      console.log(
        `模型：${model.id}，${maxTurns ? `最多${maxTurns}轮` : "不限制轮数"}`,
      );
      const report = await runPort({
        root,
        runtime,
        model,
        maxTurns,
        timeoutMs: timeout * 1000,
        download: v["allow-download"],
        signal: controller.signal,
        onProgress: console.log,
        feedback,
      });
      console.log(
        `${report.text ?? ""}\n${report.status} · ${report.turns}轮；会话已保存，正式接受仍以独立验收为准。`,
      );
      if (report.status !== "candidate_ready") process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  });
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
