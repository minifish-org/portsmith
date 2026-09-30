# Portsmith user manual

A prepared v2 workflow runs with one `migrate` command. You do not select each unit, judge, output or task manually. Steps advance automatically and a complete module is committed after cumulative and project integration checks pass.

## Build and run

Use Node >=22.19 and Go >=1.24; race checks also require the local C toolchain. On a fresh checkout run `npm ci`, then `npm run build` after source updates.

For Pith's additive embedded SDK plan:

```sh
cd ~/work/pith
node ../portsmith/dist/cli.js migrate --plan migration/sdk --check
node ../portsmith/dist/cli.js migrate --plan migration/sdk --commit --env-file ../omni-pi/.env
```

The original AI/Core/Tools migration uses `--plan migration`. It has 24 batches and 26 steps; the SDK increment has seven steps. A completed plan reports `complete` instead of `ready`; do not delete its journal to force another run. Check the target project's plan-specific README for exact scope and paths.

`--check` makes no model calls or commits. `ready` and `canStart: true` mean preparation is complete, not that implementation is correct. `needs-preparation` exits with code 2; the planner must resolve every missing batch before execution under the default `all-prepared` policy. `available-steps` is an explicit debugging policy, not a complete preparation claim.

`--commit` permits preparation-file and accepted-module commits but never pushes. Actual generation sends source context to the configured provider and incurs its usage charges.

## Configuration and budgets

`--env-file` loads the existing provider configuration. `PORTSMITH_BASE_URL`, `PORTSMITH_MODEL` and `PORTSMITH_API_KEY` take precedence over `OMNI_*`; process environment values take precedence over the env file. The endpoint must support Chat Completions tool calls. Never put keys into committed files.

Known DeepSeek models use the pinned Pi catalog capacities: the pinned DeepSeek Flash entry has a 1,000,000-token context and 384,000-token maximum response. This is a capacity, not a promised response length; input and output still share context. Unknown compatible models have conservative defaults. Explicit `PORTSMITH_CONTEXT_WINDOW` and `PORTSMITH_MAX_TOKENS` overrides must fit the known capacity and output must be smaller than context.

- `--max-turns` and `--timeout` default to zero (unlimited). Positive values explicitly bound a model session run. Reaching a budget preserves the session and candidate.
- `--max-attempts` defaults to zero (unlimited). It counts outer generation/repair attempts after the model finishes, not every compile or tool call inside a Pi session.
- `--max-units 1` accepts at most one whole module in v2, not one internal step.
- `--allow-download` permits missing frozen Go dependencies to be fetched; it does not authorize changing their versions.

Length-truncated model replies trigger continuation with preserved context. Their tool calls are not executed. Explicit budgets can stop continuation; the report identifies the limit and preserves progress. Model errors still stop after applicable retries rather than being misreported as success.

## Execution and evidence

```text
ready step -> source/contract/judge snapshot -> candidate generation
  -> formatting/compile/vet -> candidate tests -> cumulative judges -> race
  -> step checkpoint -> next step
  -> complete module -> actual-project integration tests -> commit
```

Pi keeps native tools, normal settings, resources, thinking, compaction and retries. `verify_candidate` returns concrete independent diagnostics. Model claims do not replace verification. Earlier files in the current module can be repaired; accepted dependencies remain read-only. Output paths are exact manifests, including approved textual assets.

Task directories contain references, candidate, judges, verification.json, last-run.json, pi-sessions and event logs. V2 uses `.portsmith/modules.json` by default; the SDK plan uses `.portsmith/sdk/modules.json` and `.portsmith/sdk/runs/`. Formal code and `migration/results/<module>.json` are committed only after module acceptance.

## Resume

Rerun the same command after interruption. A complete candidate is verified before another model call. Unfinished steps resume their own Pi conversation. Accepted steps are reused only when fingerprints and seals still match. The executor can recognize an already-created commit after a journal-write interruption.

Appending future unexecuted steps is supported; changing completed contracts/sources/judges, inserting earlier steps or expanding accepted modules requires a reviewed new plan. Do not erase the whole journal. Manifest changes after the last step require another regression step. Resolve unrelated changes and target conflicts explicitly; the executor does not reset your checkout. Remove a stale `.lock` only after confirming its process has exited.

## Manual and legacy commands

V1 plans continue to use `.portsmith/migrate.json`; prepare/run/verify/accept/status/next remain available. Do not change a v2 version field to bypass validation. `--example event-stream` is an optional tutorial fixture, not the real project migration.

Default snapshots and logs have no artificial size/count caps, and verifier processes/Go tests have no default timeout. Go controls compilation concurrency and memory. Ctrl-C cancels active verification. Provider and system limits still apply; integrity failures are never skipped. Native tools and test code have local-user privileges, not an OS sandbox.

See [workflow schema](module-workflow.md), [architecture](design.md) and [tutorial](tutorial.md).
