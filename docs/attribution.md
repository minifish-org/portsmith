# 来源和借鉴

- 本项目由 omni-pi 中的小型手动移植原型提取并扩展。Portsmith的仓库许可证保持为用户创建仓库时选择的AGPL-3.0。
- `examples/event-stream/source/` 来源于 [Pi](https://github.com/earendil-works/pi) v0.87.1，提交 `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`；具体来源和压缩包校验信息在示例的 `provenance.json`，原许可证在 `source/LICENSE`。
- `examples/event-stream/reference-go/` 是此前Pi + DeepSeek实验生成并验证的移植候选，保留Pi的MIT归属。它用于重放验证流程，不是完整生产级Pi内核。
- 迁移流程参考 [Anthropic Code Migration Kit](https://github.com/anthropics/code-migration-kit-with-claude-code)：先规划和规则、先建立验证、检查目标包循环、验证已知错误、把任务证据落盘。本项目没有复制该仓库脚本和模板实现，也不依赖Claude Code。我们的任务粒度、Go逐模块验证和状态收据根据自身需求实现。
- 对迁移方法的另一个参考是 [Microsoft TypeScript Go port](https://github.com/microsoft/typescript-go)：保持可验证行为、固定来源、复用测试、显式记录差异。

原始源码及衍生示例的许可证与Portsmith工具自身分开保留。Portsmith不向生成物自动添加自身许可证；实际生成物的许可应按所移植源码和依赖处理。
