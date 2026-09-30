# Historical local acceptance record: 0.1

Date: 2026-09-28. Environment: macOS arm64, Node 22.22.3, Go 1.24.2. This records the checks performed at that time, not the current test count.

## Checks performed

- Type checking and distributable JavaScript build passed.
- Thirteen automated tests passed, covering frozen sources, paths, real Pi SDK tool loops, resolution, package cycles, plan changes, locks, exact edits, process timeout, independent verification, stale receipts and dependencies.
- The offline EventStream example passed seven TS reference scenarios, Go cancellation checks and candidate tests. The judge rejected a known-wrong Go implementation.
- A live DeepSeek run produced the first candidate in seven turns. Review found an intermittent defect when a resolved result and cancelled context were both ready: a targeted repeated test failed 14 of 20 runs.
- During repair, a trailing fragment overwrote a whole test file and compilation failed. Exact editing and complete-file package checks were added. Subsequent independent verification and 20 repeated targeted checks passed.
- An intermediate truncated response was classified as a model error; candidate files were preserved and independently checked. Model narrative was not accepted as test evidence.
- A frozen `github.com/google/uuid v1.6.0` dependency passed compile, candidate and independent tests using the local module cache with downloads disabled.
- npm packing, installation into a temporary project, installed CLI execution and the offline example passed. The package excluded env files, model logs and local tasks.
- The verified live-model candidate was exported locally to `.portsmith/accepted-event-stream`. That historical run did not integrate it into Pith or publish the repository.

## Historical Pi snapshot analysis

The initial partial snapshot contained 1,153 TS/JS files and 276,094 physical lines. Directory grouping produced 63 draft tasks and six target-package cycle groups. It lacked the root tsconfig.base.json and contained 477 unresolved/computed references. These were reported as preparation gaps, not complete dependency coverage.

These checks establish the workflow and selected example only. They did not establish a complete Pi port, all Go concurrency/reentrancy/platform behavior or performance, and did not claim hosted CI had run. Later release evidence is recorded separately.
