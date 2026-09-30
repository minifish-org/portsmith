# First exercise: inspect one migration

This is an optional offline exercise. For a real prepared project, use [the manual](user-manual.md).

1. Run `npm run demo`. It replays an existing Go candidate without calling a model and prints a task directory, referred to below as `<task>`.
2. Read `examples/event-stream/source/packages/ai/src/utils/event-stream.ts`, its tests and `<task>/task.json`. The example ports the generic FIFO event stream, excluding the assistant-message specialization. `RULEBOOK.md` defines common rules; the goal defines this API.
3. Read `src/agent.ts`. Pi provides native read/write/edit/bash/grep/find/ls tools and the agent loop. Portsmith adds `verify_candidate`, persistent sessions and evidence management. Native tools are not an OS sandbox.
4. Inspect `oracle.json`, `verification.json` and `judge-check.json`. The reference records seven TS scenarios; independent tests are distinct from model-written tests. A known-wrong implementation must fail the judge.
5. Add a comment to `<task>/candidate/event_stream.go`, then run `npm run dev -- status --task <task>`. Even a comment changes the fingerprint and makes verification stale. Run `verify` again. To explore a real defect, change FIFO behavior in a copy; do not weaken the judge.
6. Prepare a fresh task as described in the README and run it with a configured model. `run-*.jsonl` records tool/model events. Pi can compile, test and repair in the same session; rerunning resumes the conversation. Optional positive `--max-turns` and `--timeout` values set explicit budgets.

## Bring your own judge

```text
my-judge/
  judge_test.go
  testdata/
    expected.json
```

Test names must start with `TestPortsmithJudge`. For multiple Go packages, match the candidate directory layout. Establish expected behavior from the original implementation and check that a known-wrong candidate fails. Pass `--judge my-judge` during preparation. Files are frozen and verified by hash; a task without an independent judge cannot claim behavior verification.

After review, `accept --task <task> --out <new-directory>` exports verified Go source and a receipt. It does not create a desktop installer, commit to Pith or publish a product.
