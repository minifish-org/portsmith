# Attribution

Portsmith grew out of a local Pi migration experiment. Its existing repository license remains AGPL-3.0-only.

- Pi: <https://github.com/earendil-works/pi>, version 0.87.1, revision `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`. The EventStream source fixture includes its original MIT license and provenance metadata.
- `examples/event-stream/reference-go/` is an earlier Pi + DeepSeek migration candidate used to replay the verification workflow, not a complete production agent kernel. Its Pi attribution is preserved.
- Anthropic's [Code Migration Kit](https://github.com/anthropics/code-migration-kit-with-claude-code) informed the method: plan first, establish tests, check package cycles, reject known-wrong implementations, and retain evidence. Portsmith does not depend on Claude Code or copy that repository's scripts/templates.
- Microsoft's [TypeScript Go port](https://github.com/microsoft/typescript-go) informed the emphasis on behavioral compatibility, test reuse, and explicit differences.

Upstream fixture licenses remain separate from the migration tool's license. Generated code must retain the notices required by its source and dependencies; Portsmith does not assign its own license to generated files.
