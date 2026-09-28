import { eventStreamOracle } from "./event-stream.js";
try {
  process.stdout.write(
    JSON.stringify(await eventStreamOracle(process.argv[2])),
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
