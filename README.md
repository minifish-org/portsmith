# Portsmith

用 Pi 和你选择的模型，把一组 TypeScript 行为移植成可检查的 Go 候选。先看清范围和规则，再生成代码，最后用独立测试判断结果。

这是一个可运行的 **TS → Go 命令行工作台**。支持 DeepSeek 和 OpenAI 兼容的 Chat Completions 接口。项目目前是 0.1 实验版；没有自动全库重写、自动合并或完整兼容保证。

## 先跑一次，不需要模型密钥

需要 Node.js ≥ 22.19、npm，以及本机 Go ≥ 1.24。默认关闭 CGO、Go 工具链下载和依赖下载，编译并发为 2。

```sh
npm ci
npm run demo
```

这个命令重放仓库内已有的 EventStream Go 实现，**不调用模型，不声称重新生成了代码**。它会：

1. 冻结 Pi 的源码、测试、许可证和迁移规则。
2. 运行原 TS，生成 7 个场景的参考事件轨迹。
3. 编译、运行 Go 自测和独立对照测试。
4. 用一个可以编译但行为错误的实现，确认验证器能发现问题。
5. 显示任务目录和 `behavior_verified` 状态。

结果在被 Git 忽略的 `.portsmith/demo-*/`。这个状态只表示所选场景通过。

## 用模型做一次真实移植

```sh
cp .env.example .env
# 在本机编辑 .env，填写接口、模型 ID 和密钥

npm run dev -- prepare \
  --source examples/event-stream/source \
  --out .portsmith/my-first-port \
  --revision pi-v0.87.1-f07218c4 \
  --example event-stream

npm run dev -- run --task .portsmith/my-first-port

# 检查候选代码后执行：
npm run dev -- verify --task .portsmith/my-first-port
npm run dev -- status --task .portsmith/my-first-port
```

`run` 的四个工具：读选定源码、读候选、写完整候选、精确修改候选。模型不能运行命令、修改依赖清单或修改独立验证器。失败后再次运行 `run`，它会读取已有候选及上次验证诊断，再执行 `verify`。

人工审阅发现额外问题时，可加 `--feedback review.md`，把具体发现交回模型修复。常规测试通过不意味着没有遗漏；测试范围和审阅意见都应该明确记录。

如果已有 omni-pi 配置，可以显式复用，不必复制密钥：

```sh
npm run dev -- run --task .portsmith/my-first-port --env-file ../omni-pi/.env
```

支持 `PORTSMITH_BASE_URL / MODEL / API_KEY`，兼容原 `OMNI_*`；前者优先。环境变量优先于 `.env`。模型端必须支持工具调用。日志和候选会包含所选源码；配置密钥不写入任务清单。模型价格没有配置，因此 SDK 的 cost=0 不表示免费。

## 分析和规划一个项目

```sh
npm run dev -- analyze --source /path/to/typescript-project --out .portsmith/analysis.json
npm run dev -- plan --analysis .portsmith/analysis.json --out .portsmith/plan --revision <上游版本或提交>
```

这两步不用模型。分析使用 TypeScript Compiler API，识别导入、导出、路径别名、相对 `.js` → `.ts` 映射、文件循环及无法解析的引用。外部依赖和项目内部未解析的引用分开记录。

`plan.json` 按源目录提出初始分组，**需要你编辑**：

- `files`：这次实际移植哪些源码。
- `references`：模型还需要阅读哪些依赖和测试，不要求全部移植。
- `goal` / `acceptance`：目标及可检验的行为，后者不能为空。
- `targetPackage`：预期的 Go 包目录，同一包使用同一值。
- `dependsOn`：依赖的任务 ID；循环中的任务需要合并或重新划分。
- `notes`：未解析引用及依赖替换等待决事项。

再编辑 `RULEBOOK.md`，统一错误、空值、取消、事件顺序、共享类型和依赖选择。成熟第三方库可以采用，不要求零依赖。

```sh
npm run dev -- prepare --plan .portsmith/plan --unit <任务ID> --out .portsmith/tasks/<任务ID>
npm run dev -- status --plan .portsmith/plan --runs .portsmith/tasks
npm run dev -- next --plan .portsmith/plan --runs .portsmith/tasks
```

`next` 只列出依赖已经通过行为验证的未完成任务，不会偷偷调用模型。修改计划后已有任务显示 `plan_changed`，需要重新准备快照。第一版不自动拼接多个候选模块；明确共享接口后，由你组装 Go 项目或为一个任务提供必要候选源码。

## 依赖、独立测试和导出

任意任务都可指定 `--file` 多次和 `--goal`，不必使用计划。第三方依赖通过准备好的 `--go-mod` 和 `--go-sum` 传入并冻结；验证时加 `--allow-download` 才允许从公共 Go 代理下载。工具不自动替你选择依赖。

通过 `--judge <目录>` 放入人审的独立 Go 测试和固定数据。测试名必须以 `TestPortsmithJudge` 开头；没有匹配测试、全跳过或测试失败，都不能标记行为已验证。多包任务把 judge 文件按候选中的包目录放置。

内置 EventStream 有 TS 对照和验证器自检；其他模块需要你先建立独立验收测试。模型自己写的测试通过，只得到 `tests_passed`，不能冒充行为兼容。

```sh
npm run dev -- accept --task .portsmith/my-first-port --out .portsmith/accepted-event-stream
```

只有当前代码通过独立验证才能导出。目标目录必须不存在，输出包括 Go 文件、许可证和验证收据。不提交 Git、不发布，也不修改 Pith。修改候选文件后旧报告失效。

## 从哪里开始学

先读 [一步步操作](docs/tutorial.md)，再读 [架构与边界](docs/design.md)。代码顺序建议：

| 文件                                    | 负责什么                       |
| --------------------------------------- | ------------------------------ |
| `src/cli.ts`                            | 命令入口和流程连接             |
| `src/analyze.ts` / `src/plan.ts`        | 源码依赖分析和任务计划         |
| `src/workspace.ts`                      | 冻结快照、规则、依赖及文件边界 |
| `src/agent.ts` / `src/model.ts`         | Pi 工具循环与模型连接          |
| `src/verify.ts` / `src/event-stream.ts` | 编译、自测、独立行为验证       |
| `src/state.ts`                          | 当前状态与导出收据             |

```sh
npm run check
npm test
npm run build
node bin/portsmith.mjs --help
```

构建后可以 `npm link` 使用 `portsmith` 命令。生成的 npm 包仍需要 Node；**Go 候选本身不依赖 Portsmith、Pi 或 Node**。验证阶段运行 TS 参考实现才需要 Node。

## 执行边界

`verify` 和 `judge-check` 会执行本机代码，权限与当前用户相同，**不是操作系统沙箱**。它们使用独立临时目录、限制时间和 Go 编译并发，并不向子进程传入模型密钥，但这些措施不能隔离恶意代码。`run` 可用 Ctrl-C 中止，已有候选保留；崩溃留下 `.lock` 时须确认原进程退出后再移除。

项目使用仓库原有 AGPL-3.0 许可证；Pi 示例保留原 MIT 许可证和来源。方法借鉴及组件出处见 [来源说明](docs/attribution.md)。
