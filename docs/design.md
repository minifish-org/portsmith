# Portsmith 0.1 的架构与边界

```text
TS 项目 ── TypeScript API ── analysis.json
                                 │
                          plan.json + RULEBOOK.md
                                 │ 人工选定任务
                        冻结源码、规则、依赖、judge
                                 │
                           Pi + 配置的模型
                     读参考 / 读候选 / 写候选
                                 │
                           Go 候选目录
                                 │
                编译 → 候选测试 → 独立行为测试
                                 │
                          当前版本的验证收据
                                 │ 人工执行 accept
                         新目录中的 Go 产物
```

## 确定性程序和模型的分工

程序负责发现文件、解析引用、检查依赖图、保存快照、执行验证和判断收据是否过期。模型负责理解选定源码、实现 Go 代码、解释差异和修复错误。计划按目录提出分组，不通过代码行数推断兼容性；语义边界和 Go 接口仍需你确认。

`typescript` 7.0.2 用于本项目编译；`typescript-api` 是固定到 5.9.3 的 TypeScript 包别名，用于稳定的 JS Compiler API。安装的 TypeScript 7 包没有提供此前完整的解析 API，因此把这两个用途分开。分析器使用 TS 5.9 的语法和解析规则；更新语法可能需要升级这一依赖。

## 任务目录

```text
task/
  task.json           来源标签、参考文件SHA-256、配置摘要、任务依赖
  RULEBOOK.md         冻结规则
  references/         选定源码及原始LICENSE
  candidate/          可编辑Go实现，冻结go.mod/go.sum
  judge/              可选的人审测试和固定数据
  run-*.jsonl         每轮模型与工具事件
  last-run.json       最近一次模型运行摘要
  judge-check.json    内置验证器的基线和已知错误检查
  verification.json   各阶段结果、被验证内容的摘要
  acceptance.json     导出位置及收据
```

任务目录、日志和下载缓存不提交到版本库。长期迁移计划、规则、测试适配器和设计决策应该放在目标项目的 `migration/` 中。这样 Pith 的历史不依赖某次模型会话。

## 状态来自证据

- `prepared`：快照创建，还没有 Go 实现。
- `generated`：候选文件存在，尚未验证。
- `compile_failed` / `tests_failed`：对应阶段失败。
- `tests_passed`：候选自测通过，没有独立兼容证据。
- `behavior_failed` / `behavior_verified`：独立测试失败或通过。
- `stale_verification`：候选变化，旧报告失效。
- `accepted`：已导出，当前候选与导出内容都匹配收据。
- `export_changed`：导出后文件变化。

没有匹配测试、跳过测试、超时和输出截断均不能作为成功。验证过程对临时副本执行命令，结束前再次检查候选摘要，防止把变化后的文件误标记为已验证。收据不是密码学签名，也不能抵御拥有本机写权限的恶意篡改。

## 依赖选择

标准库优先，但不锁死依赖。用户可以先在一个小 Go 模块里选择成熟依赖并生成 `go.mod`/`go.sum`，再把它们交给 `prepare`。模型无法悄悄加库；依赖变更需要重新准备任务。验证使用 `-mod=readonly`，不会自动升级版本或修改清单。不支持指向本机其他目录的 `replace`。

`--allow-download` 使用公共 Go module proxy 和 checksum database；私有代理、凭据及系统动态库暂未集成。普通验证关闭 CGO，要求 race 的工作流会启用 CGO 运行 Go race 检查。手动任务彼此独立；migrate 将此前已提交的输出作为不可修改的前置文件带入新候选。

## 自动执行与提交

`migrate --plan ... --check` 只验证来源、计划、API、输出清单和必需的测试名。正式执行需要 `--commit`：允许首先提交 workflow.json 中明确列出的准备文件，随后按依赖推进，每模块通过独立测试及实际项目累计测试后提交。不会 push。

工作流将源码规则、接口、judge、依赖和验证器版本纳入摘要。生成器只能写本任务清单，前置源码和独立测试冻结。只要缺少任意必需测试的通过事件、出现跳过、超时或 race 失败，均不能集成。

每个模块先保存集成文件摘要和原 Git HEAD，再写目标文件、验证并提交。`.portsmith/migrate.json` 记录当前事务及已提交模块；中断后检查内容和提交信息进行恢复。工作区中的其他修改、已有目标文件冲突或内容被改动会停止，既不 reset，也不覆盖用户修改。计划目录有独立 go.mod，让其中的 judge 源文件不被目标模块的 `go test ./...` 当成产品包。

## 分析范围和局限

扫描忽略 `.git`、隐藏目录、node_modules、dist、build、coverage、vendor 和符号链接。记录 TS/JS 文件中的静态 import/export、字面量 require/import、import type；计算产生的导入记录为 computed，不猜测目标。

通过最近的 tsconfig 解析别名和路径。外部 npm 依赖单列；本仓库包名如果不能由 TypeScript 解析，会明确列为 unresolved。例如只有指向 dist 的 workspace exports，却没有构建产物或源码 paths 配置时，不会擅自猜一个 src/index.ts。分析报告应结合配置完整性审阅。

初始任务以目录为分组，测试通过直接导入关系关联。它不会推导所有运行时依赖、完整测试覆盖或业务语义，也不会自动追踪整个依赖闭包。准备任务会检查选定源码和扫描过的配置是否在分析后变化；引用清单过大时要求进一步拆分。

## 独立验证的边界

EventStream 的 TS 参考运行在有超时的子进程中。7个场景覆盖顺序、等待者、结束、排空和结果确定；Go 额外验证 context 取消。`judge-check` 将TS轨迹与固定基线核对，再让同一套测试检查一个能编译但行为错误的Go实现。不是穷尽的变异测试，也不证明并发竞态、吞吐性能和所有重入行为。

自定义judge是用户维护的Go测试与固定数据，只保证与生成器分离并保持快照不变。工具不会伪称这些数据已由原TS验证。应先自行通过原实现建立正确预期，并用故障实现检查测试有效性，再交给Portsmith。

暂未实现自动语义分组、自动生成可信judge、自动跟踪上游、分布式调度和自动发布。已实现基于明确工作流的多任务顺序生成、有限修复、累计验证、受限集成和逐模块提交，见 migrate.ts 和使用说明书。
