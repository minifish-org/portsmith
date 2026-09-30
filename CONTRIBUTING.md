# Contributing to Portsmith

This is an experimental project. Open an issue describing the concrete behavior you want to change before a large rewrite. Include a minimal reproduction, expected behavior, actual behavior, and toolchain versions. Never include API keys or private session logs.

Keep changes focused. Add regression coverage for behavior changes. Tests must run without paid provider calls. Document differences from upstream instead of silently weakening a migration contract. Preserve upstream provenance and license notices.

Do not hand-edit accepted migration receipts to make a failure pass. For a new upstream revision, prepare a reviewed incremental plan and new evidence. Normal runtime builds should work with `CGO_ENABLED=0`; do not introduce dependencies requiring CGO without an explicit architecture decision. Race-test instrumentation is a separate testing concern.

Run the checks documented in README before proposing a change. Contributions are reviewed under the repository's existing license; no CLA is currently provided.

## Language

Use English for maintained code comments, CLI messages, errors, help and public documentation. Keep raw upstream material, hash-bound historical migration evidence and multilingual behavioral test inputs unchanged. See [the language audit](docs/language-audit.md) for recorded exceptions. Do not translate user/model content or subprocess output as if it were a product message.
