import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareTask, EVENT_GOAL, writeCandidate } from "./workspace.js";
import { verifyPort } from "./verify.js";
import { taskStatus } from "./state.js";

// An offline replay, explicitly not a fresh model generation.
const example = fileURLToPath(
  new URL("../examples/event-stream/", import.meta.url),
);
const root = path.resolve(`.portsmith/demo-${Date.now()}`);
await prepareTask({
  source: path.join(example, "source"),
  out: root,
  revision: "pi-v0.87.1-f07218c4",
  files: [
    "packages/ai/src/utils/event-stream.ts",
    "packages/ai/test/event-stream.test.ts",
  ],
  goal: EVENT_GOAL,
  example: "event-stream",
});
for (const name of ["event_stream.go", "event_stream_test.go", "NOTES.md"])
  await writeCandidate(
    root,
    name,
    await readFile(path.join(example, "reference-go", name), "utf8"),
  );
console.log(`Replaying the existing example offline (no model calls): ${root}`);
const report = await verifyPort(root);
console.log(JSON.stringify(await taskStatus(root), null, 2));
if (report.status !== "behavior_verified") {
  console.error(JSON.stringify(report, null, 2));
  process.exitCode = 1;
}
