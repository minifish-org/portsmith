import { spawn } from "node:child_process";

export type ProcessResult = {
  code: number | null;
  timedOut: boolean;
  truncated: boolean;
  cancelled?: boolean;
  log: string;
};
export function cleanEnv(download = false, race = false): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    SystemRoot: process.env.SystemRoot,
    GOTOOLCHAIN: "local",
    CGO_ENABLED: race ? "1" : "0",
    GOENV: "off",
    GOWORK: "off",
    GOPROXY: download ? "https://proxy.golang.org" : "off",
    GOSUMDB: download ? "sum.golang.org" : "off",
  };
}
export async function execute(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 0,
  download = false,
  race = false,
  maxLogChars = Infinity,
  signal?: AbortSignal,
): Promise<ProcessResult> {
  if (signal?.aborted)
    return {
      code: null,
      timedOut: false,
      truncated: false,
      cancelled: true,
      log: "操作已取消",
    };
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: cleanEnv(download, race),
      detached: process.platform !== "win32",
    });
    let log = "",
      timedOut = false,
      truncated = false,
      cancelled = false;
    const record = (data: Buffer) => {
      log += data.toString();
      if (log.length > maxLogChars) {
        log = log.slice(-maxLogChars);
        truncated = true;
      }
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const abort = () => {
      cancelled = true;
      kill();
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            kill();
          }, timeoutMs)
        : undefined;
    child.on("error", (e) => {
      log += e.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({
        code,
        timedOut,
        truncated,
        log,
        ...(cancelled ? { cancelled: true } : {}),
      });
    });
  });
}
export const executeGo = (
  directory: string,
  args: string[],
  download = false,
  race = false,
  signal?: AbortSignal,
) =>
  execute(
    "go",
    [
      "test",
      "-json",
      "-mod=readonly",
      "-count=1",
      "-timeout=0",
      ...(race ? ["-race"] : []),
      ...args,
      "./...",
    ],
    directory,
    0,
    download,
    race,
    undefined,
    signal,
  );
export function testResults(result: ProcessResult, prefix = "") {
  const events = result.log.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const tests = events.filter(
    (e) => typeof e.Test === "string" && e.Test.startsWith(prefix),
  );
  return {
    passed: tests.filter((e) => e.Action === "pass").length,
    failed: tests.filter((e) => e.Action === "fail").length,
    skipped: tests.filter((e) => e.Action === "skip").length,
    passedNames: [
      ...new Set(
        tests.filter((e) => e.Action === "pass").map((e) => e.Test as string),
      ),
    ],
  };
}
export const succeeded = (r: ProcessResult) =>
  r.code === 0 && !r.timedOut && !r.truncated && !r.cancelled;
