import type { Verification } from "./verify.js";

/** Go emits compiler diagnostics as build-output, and test diagnostics as output. */
export function processDiagnostics(log: string): string {
  return log
    .split("\n")
    .flatMap((line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return [line];
      }
      if (!event || typeof event.Action !== "string") return [line];
      // Keep Output even for new event kinds, so a Go update cannot hide errors.
      if (typeof event.Output === "string")
        return /^(=== RUN|=== PAUSE|=== CONT|--- PASS|PASS$)/.test(
          event.Output.trim(),
        )
          ? []
          : [event.Output.trimEnd()];
      if (event.Action === "fail" || event.Action === "build-fail")
        return [
          `FAIL ${event.Test ?? event.ImportPath ?? event.Package ?? ""}`,
        ];
      return [];
    })
    .join("\n")
    .trim();
}

export function verificationDiagnostics(
  report: Pick<Verification, "status" | "phases">,
  maxChars = 24000,
): string {
  const failed = report.phases.filter(
    (p) => p.result.code !== 0 || p.result.timedOut || p.result.truncated,
  );
  const phases = failed.length ? failed : report.phases.slice(-1);
  const text = [
    `Verification status: ${report.status}`,
    ...phases.map(
      ({ name, result }) =>
        `${name} (exit code ${result.code}${result.timedOut ? ", timed out" : ""}${result.truncated ? ", raw output truncated" : ""}):\n${processDiagnostics(result.log)}`,
    ),
  ].join("\n");
  const marker =
    "\n[Diagnostic summary truncated; see verification.json for full output]";
  return text.length <= maxChars
    ? text
    : text.slice(0, Math.max(0, maxChars - marker.length)) + marker;
}
