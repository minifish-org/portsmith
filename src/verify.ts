import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicJson, checkedFile, copyFiles, hash, readJson } from "./files.js";
import { goOracle } from "./event-stream.js";
import { candidateFiles, fingerprint, loadTask } from "./workspace.js";
import {
  execute,
  executeGo,
  succeeded,
  testResults,
  type ProcessResult,
} from "./process.js";

// Bump when validation behavior changes: old receipts must not validate a new verifier.
export const VERIFIER_VERSION = "portsmith-go-v3";
export type Verification = {
  version: 1;
  verifier: string;
  at: string;
  fingerprint: string;
  status:
    | "compile_failed"
    | "tests_failed"
    | "tests_passed"
    | "behavior_failed"
    | "behavior_verified";
  oracleCases: number;
  independent: boolean;
  fullParityProven: false;
  phases: { name: string; result: ProcessResult }[];
};
async function golden(root: string, signal?: AbortSignal) {
  const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const worker = fileURLToPath(
    new URL(`./oracle-worker.${ext}`, import.meta.url),
  );
  const run = await execute(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), worker, root],
    root,
    0,
    false,
    false,
    undefined,
    signal,
  );
  if (!succeeded(run))
    throw new Error(`TS reference execution failed or timed out: ${run.log}`);
  const result = JSON.parse(run.log);
  if (!Array.isArray(result) || result.length !== 7)
    throw new Error("TS reference did not generate all 7 scenarios");
  return result;
}
async function injectOracle(temp: string, data: unknown) {
  await writeFile(path.join(temp, "port_oracle.json"), JSON.stringify(data));
  await writeFile(
    path.join(temp, "portsmith_judge_test.go"),
    goOracle
      .replaceAll("TestPortOracle", "TestPortsmithJudgeOracle")
      .replaceAll(
        "TestPortResultCancellation",
        "TestPortsmithJudgeCancellation",
      ),
  );
}

const broken = `package port
import "context"
type StreamItem[T any] struct { Value T; Done bool }
type EventStream[T any,R any] struct{}
func NewEventStream[T any,R any](func(T)bool,func(T)R)*EventStream[T,R]{return &EventStream[T,R]{}}
func(s *EventStream[T,R])Push(T){}
func(s *EventStream[T,R])End(*R){}
func(s *EventStream[T,R])Next()<-chan StreamItem[T]{ch:=make(chan StreamItem[T],1);ch<-StreamItem[T]{Done:true};return ch}
func(s *EventStream[T,R])Result(context.Context)(R,error){var r R;return r,nil}
`;
export async function judgeCheck(rootInput: string, signal?: AbortSignal) {
  const { root, task } = await loadTask(rootInput);
  if (task.example !== "event-stream")
    throw new Error(
      "judge-check supports the built-in EventStream baseline; custom judges need their own baseline and mutation evidence",
    );
  const data = await golden(root, signal);
  const baseline = [
    [
      { result: 3 },
      { done: false, value: 1 },
      { done: false, value: 2 },
      { done: false, value: 3 },
      { done: true, value: 0 },
    ],
    [
      { done: false, value: 1 },
      { done: false, value: 2 },
      { done: false, value: 3 },
      { done: true, value: 0 },
      { result: 7 },
    ],
    [
      { result: 42 },
      { done: false, value: 5 },
      { done: false, value: 6 },
      { done: true, value: 0 },
    ],
    [
      { done: false, value: 7 },
      { done: false, value: 8 },
      { done: true, value: 0 },
    ],
    [
      { done: true, value: 0 },
      { done: true, value: 0 },
    ],
    [{ result: 3 }, { done: false, value: 3 }, { done: true, value: 0 }],
    [{ result: 0 }, { done: true, value: 0 }],
  ];
  if (JSON.stringify(data.map((c) => c.expected)) !== JSON.stringify(baseline))
    throw new Error(
      "Original TS behavior differs from the judge baseline; review the judge and source revision",
    );
  const temp = await mkdtemp(path.join(tmpdir(), "portsmith-judge-"));
  try {
    await writeFile(
      path.join(temp, "go.mod"),
      "module example.com/judge-check\n\ngo 1.24\n",
    );
    await writeFile(path.join(temp, "broken.go"), broken);
    await injectOracle(temp, data);
    const build = await executeGo(temp, ["-run", "^$"], false, false, signal);
    if (!succeeded(build))
      throw new Error(
        `Faulty sample did not compile and cannot validate the judge: ${build.log}`,
      );
    const run = await executeGo(
      temp,
      ["-run", "^TestPortsmithJudge"],
      false,
      false,
      signal,
    );
    const caught = testResults(run, "TestPortsmithJudge").failed;
    if (run.code === 0 || run.timedOut || run.truncated || caught < 1)
      throw new Error(
        "Judge failed to detect a known defect and cannot be trusted",
      );
    const report = {
      version: 1,
      verifier: VERIFIER_VERSION,
      at: new Date().toISOString(),
      source: task.files,
      rules: task.rulesSha256,
      baselineCases: data.length,
      knownBrokenImplementationCaught: true,
      failedTests: caught,
      oracleSha256: hash(JSON.stringify(data)),
    };
    await atomicJson(path.join(root, "judge-check.json"), report);
    return report;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
export async function verifyPort(
  rootInput: string,
  download = false,
  signal?: AbortSignal,
): Promise<Verification> {
  signal?.throwIfAborted();
  const { root, task } = await loadTask(rootInput);
  // Normalize only writable candidate Go files; frozen seeds and judges are immutable.
  const writableGo = (await candidateFiles(root))
    .filter(
      (f) =>
        f.name.endsWith(".go") &&
        !task.seedFiles?.some((s) => s.name === f.name),
    )
    .map((f) => "./" + f.name);
  if (writableGo.length) {
    const formatted = await execute(
      "gofmt",
      ["-w", ...writableGo],
      path.join(root, "candidate"),
      0,
      download,
      false,
      undefined,
      signal,
    );
    if (!succeeded(formatted))
      throw Error(`Go formatting/syntax check failed: ${formatted.log}`);
  }
  const before = await fingerprint(root);
  const files = await candidateFiles(root);
  if (
    !files.some((f) => f.name.endsWith(".go") && !f.name.endsWith("_test.go"))
  )
    throw new Error("Candidate directory contains no Go implementation");
  const temp = await mkdtemp(path.join(tmpdir(), "portsmith-verify-"));
  const report: Verification = {
    version: 1,
    verifier: VERIFIER_VERSION,
    at: new Date().toISOString(),
    fingerprint: before,
    status: "compile_failed",
    oracleCases: 0,
    independent: false,
    fullParityProven: false,
    phases: [],
  };
  try {
    for (const f of files)
      if (
        (f.name.endsWith("_test.go") &&
          /^\s*func\s+TestPortsmithJudge\w*\s*\(/m.test(f.data.toString())) ||
        f.name
          .split("/")
          .some(
            (p) =>
              p.startsWith("port_oracle") || p.startsWith("portsmith_judge"),
          ) ||
        task.judgeFiles.some((j) => j.name === f.name)
      )
        throw new Error(
          "Candidate conflicts with an independent verifier path or reserved test prefix",
        );
    await copyFiles(temp, files);
    const build = await executeGo(
      temp,
      ["-run", "^$"],
      download,
      false,
      signal,
    );
    report.phases.push({ name: "compile", result: build });
    const vet = succeeded(build)
      ? await execute(
          "go",
          ["vet", "-mod=readonly", "./..."],
          temp,
          0,
          download,
          false,
          undefined,
          signal,
        )
      : undefined;
    if (vet) report.phases.push({ name: "vet", result: vet });
    if (succeeded(build) && vet && succeeded(vet)) {
      report.status = "tests_failed";
      const tests = await executeGo(temp, [], download, false, signal);
      report.phases.push({ name: "candidate-tests", result: tests });
      const counts = testResults(tests);
      if (succeeded(tests) && counts.passed > 0 && counts.skipped === 0) {
        report.status = "tests_passed";
        if (task.example || task.judgeFiles.length) {
          report.status = "behavior_failed";
          if (task.example) {
            await judgeCheck(root, signal);
            const data = await golden(root, signal);
            report.oracleCases = data.length;
            await injectOracle(temp, data);
            await atomicJson(path.join(root, "oracle.json"), data);
          } else {
            for (const f of task.judgeFiles) {
              const data = await readFile(
                await checkedFile(root, `judge/${f.name}`),
              );
              await copyFiles(temp, [{ name: f.name, data }]);
            }
          }
          const judge = await executeGo(
            temp,
            ["-run", "^TestPortsmithJudge"],
            download,
            false,
            signal,
          );
          report.phases.push({ name: "independent-behavior", result: judge });
          const jc = testResults(judge, "TestPortsmithJudge");
          report.independent = true;
          if (
            succeeded(judge) &&
            jc.passed >= (task.example ? 9 : 1) &&
            jc.skipped === 0 &&
            (task.requiredJudgeTests ?? []).every((name) =>
              jc.passedNames.includes(name),
            )
          ) {
            report.status = "behavior_verified";
            if (task.race) {
              const race = await executeGo(
                temp,
                ["-run", "^TestPortsmithJudge"],
                download,
                true,
                signal,
              );
              report.phases.push({ name: "race", result: race });
              const rc = testResults(race, "TestPortsmithJudge");
              if (
                !succeeded(race) ||
                rc.skipped ||
                !(task.requiredJudgeTests ?? []).every((name) =>
                  rc.passedNames.includes(name),
                )
              )
                report.status = "behavior_failed";
            }
          }
        }
      }
    }
    signal?.throwIfAborted();
    if ((await fingerprint(root)) !== before)
      throw new Error(
        "Code changed during verification; report invalidated, retry verification",
      );
    await atomicJson(path.join(root, "verification.json"), report);
    return report;
  } catch (e) {
    if ((await fingerprint(root)) === before) {
      report.phases.push({
        name: "verifier-error",
        result: {
          code: 1,
          timedOut: false,
          truncated: false,
          log: e instanceof Error ? e.message : String(e),
        },
      });
      await atomicJson(path.join(root, "verification.json"), report);
    }
    throw e;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
export async function currentVerification(root: string) {
  try {
    const report = await readJson<Verification>(root, "verification.json");
    return {
      report,
      current:
        report.verifier === VERIFIER_VERSION &&
        report.fingerprint === (await fingerprint(root)),
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}
