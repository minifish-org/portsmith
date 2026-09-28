# 第一课：看清一次移植

本文是内置示例的学习练习。要操作 Pith 的正式迁移，请读 [使用说明书](user-manual.md)，其中明确说明已完成的准备和仍需建立的独立验收测试。

先在项目根目录运行 `npm run demo`。这是不用密钥的离线练习，会打印新的任务路径。以下用 `<task>` 代表它。

## 1. 先看输入

打开 `examples/event-stream/source/packages/ai/src/utils/event-stream.ts`。它有事件队列、等待者、结束状态和最终结果。看对应测试，再看 `<task>/task.json` 的 `goal`：这次只移植通用事件流，不做依赖完整消息类型的子类。

`RULEBOOK.md` 规定一般原则，`goal` 规定本次具体API。二者会在每次模型运行时一起提供。

## 2. 看模型究竟能做什么

读 `src/agent.ts` 中的四个工具。

- `read_reference` 只能读参考清单中的文件。
- `read_candidate` 可以查看已有候选。
- `write_candidate` 创建或替换完整候选文件；`edit_candidate` 对已有文件做精确局部修改。二者不能修改独立测试和依赖清单。

Pi负责“请求模型 → 调用工具 → 回传结果 → 继续请求模型”的循环。Portsmith负责控制边界和管理证据。

## 3. 看验证而不是只看编译成功

打开 `<task>/oracle.json`，里面是原TS执行后的事件轨迹。再看 `verification.json` 的三个阶段。`independent-behavior` 是工具维护的测试，不是模型自己生成的测试。

打开 `judge-check.json`，可以看到7个TS基线场景和已知错误实现的失败记录。这是检查测试工具本身有用的证据。

## 4. 亲手验证状态会失效

在 `<task>/candidate/event_stream.go` 中增加一行注释，然后运行：

```sh
npm run dev -- status --task <task>
```

即使只改注释，也会出现 `stale_verification`，因为现在的文件已经不是原来那份被验证的文件。重新执行 `verify` 才能恢复。

如果要实验错误行为，在副本中修改FIFO或结束逻辑，再执行verify。不要修改judge来迎合错误实现。

## 5. 自己让模型生成

按README创建一个新的任务，再运行 `run`。它不使用离线示例的答案；参考输入只有原TS、测试、许可证和规则。可用 `--max-turns` 和 `--timeout` 限制每次运行，已有候选在中断后保留。

读 `run-*.jsonl` 能看到模型什么时候读源码、调用了哪些工具、写了哪些文件。先检查代码，再执行verify。失败后再次run，它会读上次诊断进行修复。

## 6. 给自己的模块准备judge

先写一个人审的目录，例如：

```text
my-judge/
  judge_test.go
  testdata/
    expected.json
```

测试函数必须以 `TestPortsmithJudge` 开头。可以使用共享JSON输入和原TS产生的预期数据，让Go实现读取同样输入并比较输出。多包候选中，目录层级应对应候选Go包。

创建任务时加入 `--judge my-judge`。Portsmith冻结这份测试，模型只能读写candidate。第一次可以故意提供错误Go实现，确认独立测试失败。没有独立judge的普通任务，只能得到自测通过状态。

确认结果后用 `accept` 导出到新目录，再由你决定怎样纳入Pith。导出的是Go源码模块，不是桌面安装包或服务器成品。
