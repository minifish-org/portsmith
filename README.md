# Portsmith

An inspectable, resumable TypeScript-to-Go migration workbench powered by the Pi Coding Agent.

**Status: experimental.** Portsmith executed the first planned migration of Pi's AI, agent core, and built-in tools into [Pith](https://github.com/minifish-org/pith): 26 accepted steps across three module commits. Passing the recorded tests is evidence for the selected contracts, not proof of complete upstream equivalence.

[English guide](docs/guide.md) · [Migration evidence](docs/evidence/pith-2026-09-29.json) · [User manual](docs/user-manual.md)

## What it does

You supply a pinned source revision, a reviewed migration plan, target contracts, approved dependencies, and independent tests. Portsmith runs the plan in dependency order:

```text
plan → prepare → Pi generates and repairs Go → independent verification
     → checkpoint → next step → integration tests → one commit per module
```

Pi retains its native read/write/edit/Bash/search tools, persistent sessions, context compaction, and skills/extensions. A `verify_candidate` tool lets the model inspect real compiler and test diagnostics during the same conversation. Portsmith controls acceptance and commit recovery; the model cannot declare its own work accepted.

This is not a one-command migration planner. Producing a useful plan and trustworthy tests remains engineering work. It is not an OS sandbox: native tools run with your local user permissions.

## Install from source

Requirements: Node.js >=22.19, npm, Go >=1.24, Git, and a C toolchain for Go's optional race detector. Generated programs can still build with `CGO_ENABLED=0`.

```sh
git clone https://github.com/minifish-org/portsmith.git
cd portsmith
npm ci
npm run build
node bin/portsmith.mjs --help
cp .env.example .env
```

Set `PORTSMITH_BASE_URL`, `PORTSMITH_MODEL`, and `PORTSMITH_API_KEY` in the ignored `.env` file. Use a model/endpoint supporting Chat Completions tool calls. The recorded Pith run used DeepSeek Flash. Never commit credentials.

## Run a reviewed plan

From a target repository containing a prepared `migration/` directory, with Portsmith in a sibling directory:

```sh
node ../portsmith/dist/cli.js migrate --plan migration --check
node ../portsmith/dist/cli.js migrate --plan migration --commit \
  --env-file ../portsmith/.env
```

The first command is read-only and makes no model calls. The second may consume API credits, execute local commands, and create local Git commits; it does not push. Rerun the same command after an interruption to resume. Read [the guide](docs/guide.md) before using a plan from another repository.

Pith's committed migration directory is the **historical plan and evidence for a completed run**. Do not run it expecting a second copy of Pith in the already populated checkout. Reproduction requires the pre-migration target state, pinned upstream source, and reviewed environment setup; see its migration documentation.

## Defaults and boundaries

- No default model-turn, outer repair-attempt, wall-clock, file-count, or file-size cap; truncated responses continue automatically.
- Explicit `--max-attempts`, `--max-turns`, `--timeout`, and `--max-units` budgets remain available. Zero disables the first three budgets.
- Normal verification runs with CGO disabled; race verification enables CGO for instrumentation.
- Source, approved dependencies, independent judges, and accepted-module fingerprints remain checked. A failed check is not silently skipped.
- Authentication failures, exhausted provider retries, changed materials, and Git conflicts can still stop a run. Unlimited budgets do not guarantee unattended completion or bounded cost.
- English public documentation is available; some diagnostics and historical planning documents remain in Chinese.

## Development

```sh
npm run check
npm test
npm run build
npm run format:check
```

Tests use local model fixtures and Go tools; they do not require paid model API calls. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License and attribution

Portsmith retains its existing **AGPL-3.0-only** license. Pi-derived fixtures retain their MIT notices. The tool does not automatically impose its license on generated output. See [LICENSE](LICENSE) and [attribution](docs/attribution.md).
