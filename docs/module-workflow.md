# v2 模块执行协议

外部规划者生成 plan.json 与 workflow.json；Portsmith 不自动推断迁移范围或创作独立验收。v1 仍受支持；CLI 根据 workflow.version 分派。v2 的可执行材料需要以下字段。

## plan.json

- version: 2；source（相对 project 的源码目录）；revision；analysisSha256。
- modules：id、dependsOn、batches（有序 ID）。名称不限于 ai/core/tools。
- batches：id、module、dependsOn（同模块批次）、sources、references、outputs、behaviors、acceptance。
- analysis.json：来源静态扫描，每个选定文件及配置的 SHA-256。来源/参考文件必须属于批次范围。
- RULEBOOK.md 与独立的计划目录 go.mod（避免 judge 被正式 go test 扫入）。

## workflow.json

- version: 2；project；runs（必须在 .portsmith/）；bootstrap（允许准备提交的路径）。
- startPolicy 默认 `all-prepared`：全部批次 ready 才开始，`--check` 一次报告所有模块的缺口，不能把首步可运行当完整迁移可运行。`needs-preparation` 的 CLI 退出码为2；正式执行也在模型调用、任务创建和准备提交之前返回。
- 仅调试不完整计划时，规划者可显式设 `available-steps`，允许推进到准备边界；这不是完整交付的启动标准。Pith 使用 all-prepared。
- batches：以 batch ID 为 key，每个值含 status、reason、steps。
- status 为 planned（无步骤且说明原因）、partial（部分步骤就绪且说明缺口）、ready（全部输出均有对应步骤）。
- 每个 step：id、sources、goal、contract（文件路径）、judge（独立测试目录）、outputs（精确路径）、tests（必需且全局唯一的 TestPortsmithJudge 名称）、可选 race。

outputs 要列入对应 plan batch，或为同目录候选 \_test.go。实现可跨多个包；数据资产须精确列名，不支持把通配符当作写权限。当前支持 Go 和 UTF-8 JSON/TXT/Markdown/YAML/CSV；大型二进制资产须先设计确定性数据准备，不能假定模型能写任意文件。

每个步骤包含 Go 实现与自测文件，独立 judge 只能是 \*\_test.go 或 testdata 文件。不能覆盖 go.mod/go.sum/LICENSE、隐藏目录、migration/ 记录或冻结 judge。来源、候选及集成报告不设文件大小、数量或累计大小上限。原生 Pi 工具负责读写与搜索；上述文件约定在快照和接受阶段检查，不是工具级文件系统隔离。

## 顺序与持久化

模块依赖无环；同模块批次依赖无环。只执行已就绪步骤，批次 partial 时不让依赖它的批次通过。全部模块完成才返回 complete。

步骤候选是独立快照：同模块前序产物可写，前置模块源码只读。所有已通过步骤的 judge 累计运行，失败不提交模块。当前模块下一步的 manifest 可以更新；已有步骤的历史证据继续保留，最终累计验证和实际项目测试用当前 manifest。

完成记录保存来源/契约/judge/规则/验证器 seal、候选 fingerprint、文件摘要。补充未执行步骤可继续；改变已完成步骤、模块结构或已接受模块范围需重新规划。普通恢复不清空历史。

模块提交之前写 pending 事务、base HEAD 和暂存文件摘要；只写此前不存在的目标文件。失败不 reset 用户工作区；再次运行检查文件/提交身份，再继续。未来对已发布模块做新版本增量 port 仍需要新的明确规划和接受基线，不能把未完成迁移的恢复机制等同于自动合并任意更新。

验证需要执行本机 Go 测试，不是操作系统沙箱，不能阻止测试代码访问网络。默认验收材料应使用本地假服务；不自动 push，--check 不初始化模型。

## 固定资产与长任务

step.assets 每项含 source（计划目录内路径）、target（已登记 batch 输出）、sha256。资产提前注入候选、只读并纳入 seal；模型无需复制大段模型目录 JSON。它们随整个模块提交，后续步骤不能把同一路径声明为可写。

模型使用 Pi 原生 read/grep/find/ls 读取 `../judge` 和 `../references`，用 write/edit/bash 编码、编译和测试。`verify_candidate` 在当前会话返回独立验收结果。保留默认资源加载、思考、压缩和网络重试；`pi-sessions/` 持久化对话，重跑自动恢复，旧日志首次自动导入。验证反馈优先提供失败阶段。

默认不设置模型轮数和总时长限制，用户可显式配置预算，Ctrl-C 可中止；外层尝试次数只用于模型结束后仍未通过的验收反馈，不按会话内每次编译修复计数。外层尝试默认不限次数（--max-attempts 0），截断输出持续续写。验收进程及 Go 测试不设超时；编译并发、内存管理采用 Go 默认值，完整保留阶段日志。Ctrl-C 可取消验收进程。候选可写 Go 文件自动 gofmt；前置只读文件不改。编译、go vet、自测、独立测试与 race 均记录结果。
