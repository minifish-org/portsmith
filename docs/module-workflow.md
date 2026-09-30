# V2 module execution protocol

An external planner supplies plan.json and workflow.json. Portsmith does not infer complete migration scope or invent trustworthy independent judges. V1 remains supported; workflow.version selects the executor.

## plan.json

- `version: 2`, `source` (relative to the target project), `revision`, `analysisSha256`.
- `modules`: `id`, `dependsOn`, ordered `batches`. Names are not restricted to ai/core/tools.
- `batches`: `id`, `module`, same-module `dependsOn`, `sources`, `references`, `outputs`, `behaviors`, `acceptance`.
- `analysis.json` records SHA-256 hashes of selected source and configuration files. Sources/references must belong to their batch.
- Include `RULEBOOK.md` and a separate plan-directory `go.mod` so judge fixtures are not accidentally discovered by the product module's `go test ./...`.

## workflow.json

- `version: 2`, `project`, `runs` under `.portsmith/`, and `bootstrap` paths eligible for the preparation commit.
- `startPolicy` defaults to `all-prepared`. Every batch must be ready before generation. `--check` reports all gaps; `needs-preparation` exits with code 2 before model calls, task creation or preparation commits.
- `available-steps` explicitly permits debugging up to a preparation boundary. It is not the normal complete-plan delivery policy.
- `batches` is keyed by batch ID; each value has `status`, optional explanatory `reason`, and `steps`. `planned` has no steps, `partial` identifies remaining gaps, and `ready` covers all outputs.
- Each step has `id`, `sources`, `goal`, `contract` path, `judge` directory, exact `outputs`, globally unique required `TestPortsmithJudge` names in `tests`, and optional `race`.

Outputs must be listed in the batch or be candidate `_test.go` files beside planned outputs. Multiple Go packages are supported. Text assets require exact names; globs are not write permissions. Supported outputs are Go and UTF-8 JSON/TXT/Markdown/YAML/CSV. Binary assets need a deterministic preparation design.

Each step requires implementation and candidate tests. Independent judge files must be `_test.go` or under testdata. Candidates cannot overwrite go.mod/go.sum/LICENSE, hidden directories, migration records or frozen judges. Snapshots have no default count/size caps. Manifest checks occur during snapshot and acceptance; native tools are not filesystem sandboxing.

## Ordering, checkpoints and commits

Module and batch dependencies must be acyclic. Partial batches block dependent batches. `complete` means every module is accepted. Earlier outputs in the current module are writable initial snapshots; accepted dependencies are immutable seeds. All earlier judges run cumulatively. Dependency manifests may be updated before a future step; final cumulative and project tests use the current manifest.

Records preserve source/contract/judge/rules/verifier seals, candidate fingerprints and file hashes. Future unexecuted steps may be appended. Changes to completed steps, module structure or accepted scope require a new reviewed plan; ordinary recovery does not clear history.

Before integration, the executor records a pending transaction, base HEAD and staged hashes. Only new target files are installed. Failures preserve the checkout; recovery verifies files and commit identity rather than resetting user changes or duplicating commits.

## Additive plans against accepted code

Set `workflow.journal`, for example `.portsmith/sdk/modules.json`, and a separate `runs` directory. Omitting journal preserves the original `.portsmith/modules.json` behavior and identity. The repository-wide lock is shared.

`baseline` contains a full accepted `commit` and `files: [{name, sha256}]`. They must be regular tracked files under packages/, internal/ or cmd/ at that ancestor commit, with identical current bytes. They are injected as read-only dependencies and cannot overlap new outputs or judges. A baseline requires a separate journal. Reserved independent-judge files cannot be seeds; the original project suite runs during final integration.

This supports additive functionality, not arbitrary edits to accepted files. Changed baselines or overlapping outputs require review and replanning. `--check` creates no journal and does not initialize a model.

## Assets and long runs

Each `step.assets` entry has a plan-relative `source`, registered output `target` and `sha256`. Assets are injected read-only, included in the seal and committed with the module; later steps cannot make the same path writable.

Pi uses native read/grep/find/ls for references/judges and write/edit/bash for implementation. `verify_candidate` returns independent diagnostics in the current session. Default resources, thinking, compaction and retries remain enabled. pi-sessions/ persists conversations and imports the latest legacy log once when needed.

Default model-turn, runtime and outer repair-attempt limits are unlimited. Explicit budgets are supported; Ctrl-C preserves progress and cancels verifier processes. Outer attempts count completed model runs that still fail acceptance, not individual tool calls. Length-truncated replies continue without executing partial tool arguments. Verifier processes and Go tests have no default timeout; Go controls compilation concurrency/memory. Writable Go files are formatted; frozen seeds are not modified. Compile, vet, candidate tests, independent tests and race checks retain their logs.

Verification runs local Go code with ordinary local permissions. Use offline fake services for judges; verification is not a network sandbox. The executor never pushes automatically.
