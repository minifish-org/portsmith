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

const help = `Portsmith — 可检查、可恢复的 TS → Go 移植工作台

portsmith analyze --source <源码> --out <analysis.json>
portsmith plan --analysis <analysis.json> --out <计划目录> --revision <版本>
portsmith prepare --plan <计划目录> --unit <任务ID> --out <任务目录>
portsmith prepare --source <源码> --out <任务目录> --revision <版本>
                  --file <相对文件> [--file <测试>] --goal <目标>
portsmith prepare --source <Pi源码> --out <任务目录> --revision <版本> --example event-stream
portsmith run --task <任务目录> [--env-file <配置>] [--feedback <审阅意见.md>] [--max-turns 12] [--timeout 180]
portsmith judge-check --task <任务目录>
portsmith verify --task <任务目录> [--allow-download]
portsmith status --task <任务目录>
portsmith status --plan <计划目录> --runs <任务父目录>
portsmith next --plan <计划目录> --runs <任务父目录>
portsmith accept --task <任务目录> --out <新的导出目录>

prepare可选：--rules <规则.md> --go-mod <go.mod> --go-sum <go.sum> --judge <独立测试目录>
模型只写候选，不执行代码。verify/ judge-check执行本机代码，不是OS沙箱。
第三方Go库允许；依赖清单冻结，默认不下载。--allow-download只用于显式验证。
analyze/plan不调用模型；计划需人工补全验收条件。不会自动合并或发布。
源码修订是用户标签；SHA-256验证选定文件，不冒充Git身份验证。
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
      "max-turns": { type: "string", default: "12" },
      timeout: { type: "string", default: "180" },
      "allow-download": { type: "boolean" },
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
      !Number.isInteger(maxTurns) ||
      maxTurns < 1 ||
      maxTurns > 40 ||
      !Number.isInteger(timeout) ||
      timeout < 10 ||
      timeout > 600
    )
      throw new Error("max-turns范围1–40；timeout范围10–600秒");
    const feedback = v.feedback
      ? await readFile(v.feedback, "utf8")
      : undefined;
    if (feedback && Buffer.byteLength(feedback) > 32000)
      throw new Error("审阅反馈超过32KiB，请缩小范围");
    loadLocalEnv(v["env-file"]);
    const { runtime, model } = await configuredModel();
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
      console.log(`模型：${model.id}，最多${maxTurns}轮`);
      const report = await runPort({
        root,
        runtime,
        model,
        maxTurns,
        timeoutMs: timeout * 1000,
        signal: controller.signal,
        onProgress: console.log,
        feedback,
      });
      console.log(
        `${report.text ?? ""}\n${report.status} · ${report.turns}轮；请检查候选后运行verify。`,
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
