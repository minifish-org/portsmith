# Portsmith 使用说明书：执行 Pith 的三个模块

正常操作只需一个 migrate 命令；不必逐个指定 unit、judge、out 或 task。v2 按 `ai → core → tools` 推进，模块内部自动执行已准备的步骤，整个模块通过后提交一次。

**当前 Pith 的完整执行材料已准备：3 个模块、24 个批次、26 个自动步骤。** 实际完成进度以 `migrate --check` 和 `.portsmith/modules.json` 为准。

## 1. 本机启动

Portsmith 源码更新后先在其目录运行 `npm run build`；新机器先 `npm ci`。需要 Node ≥22.19、Go ≥1.24，以及 race 所需的本地 C 编译器。

以下命令在 Pith 根目录运行：

```sh
cd ~/work/pith
node ../portsmith/dist/cli.js migrate --plan migration --check
```

当前应看到 `status: ready`、`canStart: true`、`preparation.readyBatches: 24`、`preparedSteps: 26`、`blocked: []`。检查不调用模型、不创建提交或任务；准备通过不表示 Go 代码已经迁移完成。

现在可以正式开始：

```sh
node ../portsmith/dist/cli.js migrate \
  --plan migration \
  --commit \
  --env-file ../omni-pi/.env
```

这条命令使用真实 Pi 来源和正式 Pith 目标路径，不使用 --example，不复制演示实现。模型会读取选定源码并产生 API 用量。

- `--plan migration`：读取 Pith 中的计划、契约与 judge。
- `--commit`：允许提交明确列出的准备材料，以及最终通过验收的整个模块；不 push。补充未来步骤后也可能产生准备提交，产品代码只按模块提交。
- `--env-file`：复用已有 DeepSeek 配置；支持 `PORTSMITH_BASE_URL/MODEL/API_KEY`，兼容 `OMNI_*`，前一组优先；环境变量优先于文件。
- 默认不限制模型轮数和总时长，Pi 持续编码、编译和修复，直到结束或按 Ctrl-C。可主动加 `--max-turns 80` / `--timeout 1800` 设置每次会话运行的预算；0表示不限制。达到显式预算会停止并保留会话，不连续耗掉外层重试次数。旧命令中的这两个参数仍然生效，想取消限制需删掉它们。
- `--max-attempts` 默认0（不限制）：持续进行“Pi 宣布结束后，外层验收仍未通过”的反馈循环。Pi 在会话内调用 Bash 或 `verify_candidate` 的编译、测试和修复不消耗该次数。反馈和重跑都恢复同一 Pi 会话，已通过步骤不会重做。
- `--max-units 1`：v2 中表示最多接受一个完整模块，不表示一个内部步骤。
- `--allow-download`：仅在本机缺少冻结的 Go 依赖时，显式允许验证器下载；不会替模型升级依赖。

Pi 原生工具 `read/write/edit/bash/grep/find/ls` 全部启用，保留默认提示词、思考、上下文压缩、网络重试及技能/扩展加载。任务规则作为补充提示词；设置使用当前用户的正常 Pi 配置。`verify_candidate` 提供完整独立验收，模型可以直接看到错误并继续修复。

模型启动时会显示单次输出与工作上下文上限。官方 DeepSeek 的已知模型默认使用 Pi 固定模型目录的完整容量，不额外缩小：当前 `deepseek-flash` 为1000000 tokens上下文、384000 tokens单次输出上限。输出上限不代表每次都生成这么多；输入和输出仍须共同满足上下文限制。未知兼容模型保留较小默认值。

通常无需设置预算。需要主动缩小时，可在配置文件中添加 `PORTSMITH_MAX_TOKENS=65536`；如果同时设置 `PORTSMITH_CONTEXT_WINDOW=262144`，也必须保证输出上限小于该上下文。显式设置不能超过已知模型容量。`--max-turns` 控制调用轮数，不能提高单次输出上限。

遇到 `finish_reason=length` 时，程序保留本次上下文并持续自动续写；仅在用户显式设置轮数或时间预算时受该预算限制。被截断回复中的工具调用不会执行，避免残缺参数覆盖文件。达到显式预算时仍被截断则明确报告 `output_limit` 和 `last-run.json` 路径；候选、准备提交和已验收步骤保留，调整后重跑原命令即可。

## 2. 自动推进和停止

```text
模块 → 选择依赖已满足的已准备步骤
     → 冻结来源/契约/独立测试，载入累计候选
     → 生成 → 格式化/编译/vet → 自测 → 累计 judge → 需要时 race
     → 保存步骤检查点 → 自动下一步
     → 整个模块就绪且全部通过 → 正式集成测试 → 提交一次
     → 下一模块
```

同模块早先文件可以为整合而修改，累计 judge 始终重新验证；已经提交的前置模块按规则只读，快照校验会拒绝被改动的前置文件。精确允许的 JSON/TXT/Markdown/YAML/CSV 数据文件也可写，隐藏文件、go.mod/go.sum 和独立测试不可改。

| 状态                     | 含义和下一步                                                          |
| ------------------------ | --------------------------------------------------------------------- |
| ready + canStart:true    | 全部执行材料就绪，可以正式启动                                        |
| needs-preparation        | 全计划材料未齐；规划者补齐后才能正式启动，退出码2                     |
| paused-at-limit          | 达到指定模块数量，下次重跑继续                                        |
| complete                 | 当前完整计划的全部模块已通过自动验收并提交；真实服务 smoke 仍单独记录 |
| 模型报错/修复上限/Ctrl-C | 修复配置或审阅诊断后重跑；候选保留                                    |

**不需要先运行首步来解锁后续，也不要反复重跑期待准备材料自动产生。** 全部执行材料由规划者先补齐；Portsmith 按已准备的材料执行。仅开发调试可显式配置 available-steps，此时会报告 partially-ready 并允许推进到准备边界；Pith 的正式流程使用 all-prepared。

## 3. 哪里看生成结果

首步成功后候选在：

```text
pith/.portsmith/runs/ai/ai-foundation/eventstream/
├── task.json
├── references/
├── candidate/packages/ai/utils/eventstream/
│   ├── event_stream.go
│   └── event_stream_test.go
├── judge/
├── verification.json
├── last-run.json
├── pi-sessions/          # Pi 原生持久会话，可跨重跑恢复
└── run-*.jsonl
```

`.portsmith/modules.json` 保存 v2 的步骤和模块进度；它及任务目录被 Git 忽略。首步通过仍不会在正式 packages/ 下提交一个不完整 ai。整个模块接受后，正式代码、测试和 `migration/results/ai.json` 才一起提交。

## 4. 恢复与补充材料

重跑相同的正式命令。完整写出的取消候选会先尝试验证，通过则无需重新生成；已验证步骤先检查文件和验收 hash，内容仍一致则跳过。未完成步骤从 `pi-sessions/` 恢复已有对话；首次升级会导入旧版最后一次 `run-*.jsonl` 中的对话，不清空候选。新的会话按步骤隔离。

规划者可以给未完成批次追加步骤和 judge，并将 partial 改成 ready；不改已完成步骤的契约/来源。新依赖可在下一步骤准备前锁定，下一次累计验收会使用新 manifest。若一个尚在生成中的任务已经用旧依赖冻结，则先审查并移走该未完成任务目录，再重跑；不要删掉整个进度。最后步骤之后再改依赖，需要增加模块回归步骤。

已完成步骤的契约/来源/测试变化、在已完成步骤前插入步骤、扩展已接受模块，都拒绝沿用旧证据，需要规划者明确重做受影响范围。来源版本/模块结构/规则变化同样不能静默复用进度。

无关工作区修改、目标文件冲突、提交 hook 失败时保留现场。提交已经完成但记录尚未落盘，会识别提交而不重复提交。`.lock` 只可在确认旧进程已结束后清理。

## 5. v1 与手动入口

旧 v1 unit 计划继续可用，进度文件为 `.portsmith/migrate.json`。`prepare/run/verify/accept/status/next` 的旧计划入口仍处理 v1；v2 计划状态使用 `migrate --check`。不要把 v2 的 version 改成1绕过检查。

通用格式见 [模块工作流](module-workflow.md)。Pi 专属文件、批次和契约都在 Pith；Portsmith 没有写死这三个模块的名称。

Portsmith 默认不限制参考文件、候选及集成报告的大小、数量，不截断验收日志，也不设置验收进程和 Go 测试的超时；编译并发与内存管理使用 Go 默认值。可用 Ctrl-C 取消正在执行的验收子进程。模型服务自身容量、鉴权和系统资源仍有边界；真实错误和材料完整性检查失败仍会保留现场并报错，不会跳过验收。
