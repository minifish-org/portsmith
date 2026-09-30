# Using Portsmith

## Separate planning from execution

1. Pin the upstream revision and inventory source files, exports, imports, and dependencies.
2. Design the Go package graph and behavioral contracts. Prefer mature Go dependencies where they preserve the required behavior; do not translate TypeScript internals mechanically.
3. Prepare independent judges before generation. Include error cases, streaming boundaries, cancellation, and known-wrong candidates.
4. Group work into dependency-ordered modules with manageable internal steps.
5. Run `migrate --check`; resolve every preparation blocker before starting generation.
6. Run `migrate --commit`; inspect the accepted results and perform real-service smoke tests separately.

A planner can be a human or an external coding assistant. Portsmith executes a plan; it does not manufacture a claim of equivalence from model-written self-tests.

## Commands and files

`analyze` inventories TypeScript; `plan` creates a planning skeleton. The v2 module workflow requires reviewed contracts, tests, output manifests, and dependency decisions. [The existing schema guide](module-workflow.md) and Pith's frozen `migration/workflow.json` document the detailed structure. The schema guide and runtime messages are in English.

`prepare`, `run`, `verify`, and `accept` expose individual-task operations. `--example event-stream` is an optional tutorial fixture, not the full migration. For a prepared v2 plan, use `migrate` to advance automatically.

Each task keeps references, frozen judges, candidate files, a verification report, and a persistent Pi conversation in the target's ignored `.portsmith/runs/` directory. `.portsmith/modules.json` records progress. Module acceptance copies the selected files into the target and commits them after actual-project integration tests. Module receipts go to `migration/results/`.

## Resume and budgets

Rerun the same command. Completed steps are reused only when their fingerprints still match. A fully written candidate can be verified before another model call. Commit recovery recognizes an already created commit rather than duplicating it.

The defaults allow continued repair without a fixed attempt or time cap. Set a positive `--max-attempts`, `--max-turns`, or `--timeout` when you want a budget. `--max-units 1` means one complete module in v2. Ctrl-C preserves progress and cancels verifier subprocesses. Remove a stale `.lock` only after confirming its owner has exited.

Do not edit frozen references/judges or delete all progress to bypass a failure. New upstream revisions need a reviewed incremental plan. Do not re-use old acceptance receipts after changing their inputs.

## Environment and trust

The Pi agent uses your normal Pi settings, skills, and extensions. Use a dedicated checkout and a trusted tool configuration. The candidate directory is a working directory, not a sandbox. Independent verifiers receive a cleaned environment and use temporary copies. Dependency downloads are disabled unless explicitly allowed with `--allow-download`.

The `PORTSMITH_*` connection variables take precedence over compatible `OMNI_*` names; process environment values take precedence over the supplied env file. Known models use the pinned Pi catalog's capacities; compatible unknown models need explicit, valid capacity settings when their defaults are unsuitable.

Never publish `.env`, raw Pi sessions, or unreviewed tool logs. They may contain credentials, source material, prompts, and machine-local information. Export a compact, reviewed evidence summary instead.
