# Portsmith architecture and boundaries

```text
TypeScript project -> Compiler API -> analysis.json
                                      |
                             plan + rules + judges
                                      |
                            frozen task snapshots
                                      |
                         Pi + configured model
                  native tools <-> verify_candidate
                                      |
                     Go candidate -> independent tests
                                      |
                         current verification receipt
                                      |
                 explicit export or workflow integration
```

## Responsibilities

Portsmith uses the complete Pi coding-agent SDK, preserving its default prompt, skills, extensions, thinking, compaction and network retry behavior. Native tools perform coding; `verify_candidate` returns independent diagnostics within the same persistent session. Deterministic code handles source discovery, dependency analysis, snapshots, verification, stale receipts and commits. The model interprets source behavior and implements and repairs Go code. An external planner owns semantic scope, Go architecture and independent acceptance criteria.

TypeScript 7.0.2 builds Portsmith. The `typescript-api` alias pins TypeScript 5.9.3 for the JavaScript Compiler API; those are separate dependencies because the installed TypeScript 7 package does not expose the previous complete parsing API. Newer source syntax may require updating the analyzer dependency.

## Task layout

| File                           | Purpose                                                     |
| ------------------------------ | ----------------------------------------------------------- |
| `task.json`                    | Source revision, file/configuration hashes and dependencies |
| `RULEBOOK.md`, `references/`   | Frozen rules, selected source and original license          |
| `candidate/`                   | Writable Go output and frozen dependency manifests/seeds    |
| `judge/`                       | Independent tests and fixed data                            |
| `pi-sessions/`                 | Persistent Pi conversation, resumed across runs             |
| `run-*.jsonl`, `last-run.json` | Events and latest model-run summary                         |
| `judge-check.json`             | Built-in reference and known-wrong control evidence         |
| `verification.json`            | Phase results and verified candidate fingerprint            |
| `acceptance.json`              | Export location and receipt                                 |

Keep local tasks, model logs and caches out of Git. Commit reviewed plans, contracts and independent tests in the target project's migration directory.

## Evidence and dependencies

`prepared` is a snapshot, not implementation. `tests_passed` means candidate tests passed; `behavior_verified` additionally requires independent tests. Changed candidates invalidate prior receipts. Exports must match their receipts. Missing required tests, skipped tests, timeout and truncated process output cannot count as success. Verification runs in temporary copies and checks the candidate fingerprint again before returning. Receipts are not cryptographic signatures or protection against a malicious local writer.

Prefer the Go standard library; mature third-party libraries are allowed. The operator supplies frozen `go.mod`/`go.sum`. Verification uses `-mod=readonly`; local filesystem `replace` directives are rejected. `--allow-download` enables the public Go proxy/checksum service; private proxy credentials and system libraries are not automatically integrated. Normal verification disables CGO; race tests enable CGO for the race runtime.

## Workflow and recovery

`migrate --check` inspects preparation without model calls. `--commit` permits an explicit preparation commit and accepted module commits, never a push. Cumulative judges and actual-project tests must pass. Integration records the base HEAD, pending transaction and file hashes before writing outputs. Recovery recognizes an already-created commit. Unrelated changes and existing target files stop integration without resetting the working tree.

V1 uses `.portsmith/migrate.json`; v2 uses `.portsmith/modules.json` unless a separate journal is configured. V2 groups modules, batches and steps. Earlier outputs in the current module are writable; accepted dependencies are immutable. New additive plans can freeze an accepted baseline and use their own journal. See [the workflow schema](module-workflow.md).

## Analysis and verification limits

Scanning ignores hidden paths, build/cache/vendor directories and symlinks. It records static imports/exports, literal require/import expressions, import types, aliases and unresolved/computed imports. Workspace exports pointing at absent build artifacts are not guessed to mean source files. Directory-based draft plans do not establish semantic boundaries, transitive runtime coverage or trustworthy tests.

The EventStream example runs a TS oracle in a bounded subprocess, compares seven fixed scenarios and exercises Go cancellation. A compiling but incorrect Go control must fail the judge. This is not exhaustive concurrency, performance or mutation coverage. Custom judges are reviewed inputs, not automatically proven TS equivalence.

Native Pi file/Bash tools run with the user's permissions: the candidate working directory is not an OS sandbox. Hashes and manifests detect unintended changes but cannot prevent arbitrary local access. Automatic semantic planning, trusted judge generation, scheduled upstream tracking, distributed execution and publication are not implemented.
