import { spawn } from "node:child_process";

export type ProcessResult = {
  code: number | null;
  timedOut: boolean;
  truncated: boolean;
  log: string;
};
export function cleanEnv(download = false, race = false): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    SystemRoot: process.env.SystemRoot,
    GOMAXPROCS: "2",
    GOMEMLIMIT: "512MiB",
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
  timeoutMs = 60000,
  download = false,
  race = false,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: cleanEnv(download, race),
      detached: process.platform !== "win32",
    });
    let log = "",
      timedOut = false,
      truncated = false;
    const record = (data: Buffer) => {
      log += data.toString();
      if (log.length > 400000) {
        log = log.slice(-400000);
        truncated = true;
      }
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    child.on("error", (e) => {
      log += e.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, truncated, log });
    });
  });
}
export const executeGo = (
  directory: string,
  args: string[],
  download = false,
  race = false,
) =>
  execute(
    "go",
    [
      "test",
      "-json",
      "-mod=readonly",
      "-p",
      "1",
      "-count=1",
      "-timeout=20s",
      ...(race ? ["-race"] : []),
      ...args,
      "./...",
    ],
    directory,
    60000,
    download,
    race,
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
  r.code === 0 && !r.timedOut && !r.truncated;
