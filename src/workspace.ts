import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  atomicJson,
  checkedFile,
  copyFiles,
  hash,
  readJson,
  relativeName,
  snapshotFiles,
} from "./files.js";
import { DEFAULT_RULES } from "./plan.js";
export { hash, checkedFile } from "./files.js";

export type PortTask = {
  version: 1;
  revision: string;
  goal: string;
  example?: "event-stream";
  unit?: string;
  planDigest?: string;
  dependsOn: string[];
  files: { path: string; sha256: string; bytes: number }[];
  rulesSha256: string;
  goModSha256: string;
  goSumSha256?: string;
  judgeFiles: { name: string; sha256: string }[];
};
export const EVENT_GOAL = `移植通用 EventStream 和 FIFO 队列，package port。暂不移植 AssistantMessageEventStream。
公开接口：type StreamItem[T any] struct { Value T; Done bool }
NewEventStream[T any,R any](isComplete func(T)bool, extractResult func(T)R)*EventStream[T,R]
Push(T); Next() <-chan StreamItem[T]; End(*R); Result(context.Context)(R,error)
Next同步登记消费者，返回容量1的通道。FIFO，不广播，完成事件仍可消费；完成后忽略Push；End后排空旧事件。
第一次结果生效。End(nil)唤醒消费者但不解析Result。Result支持取消，方法并发安全。
读全部参考源码和测试。生成event_stream.go、*_test.go和NOTES.md，说明接口映射、差异和限制。保留许可证。`;

export async function prepareTask(o: {
  source: string;
  out: string;
  files: string[];
  revision: string;
  goal: string;
  example?: "event-stream";
  rules?: string;
  goMod?: string;
  goSum?: string;
  judge?: string;
  unit?: string;
  dependsOn?: string[];
  planDigest?: string;
}) {
  const source = await realpath(o.source);
  const names = [...new Set([...o.files, "LICENSE"])];
  if (!o.goal.trim() || !o.files.length || names.length > 80)
    throw new Error("需要任务说明和参考文件，最多80个文件，请按行为拆分");
  const refs = [];
  for (const name of names) {
    const file = await checkedFile(source, name);
    if ((await lstat(file)).size > 512 * 1024)
      throw new Error(`文件太大：${name}`);
    const data = await readFile(file);
    refs.push({ name, data });
  }
  if (refs.reduce((n, f) => n + f.data.length, 0) > 2 * 1024 * 1024)
    throw new Error("参考快照超过2MiB，请拆小任务");
  const rules = o.rules ? await readFile(o.rules, "utf8") : DEFAULT_RULES;
  const mod = o.goMod
    ? await readFile(o.goMod, "utf8")
    : "module example.com/portsmith-candidate\n\ngo 1.24\n";
  if (/(?:=>\s*)["']?(?:\.\.?\/|\/|[A-Za-z]:)/.test(mod))
    throw new Error(
      "独立候选不支持本地 replace；请用已发布依赖或把必要Go源码作为候选的一部分",
    );
  const sum = o.goSum ? await readFile(o.goSum) : undefined;
  const judge = o.judge ? await snapshotFiles(await realpath(o.judge), 40) : [];
  if (o.example && judge.length)
    throw new Error("内置验证器和自定义judge二选一");
  if (o.judge && !judge.some((f) => f.name.endsWith("_test.go")))
    throw new Error("judge需要独立Go测试，测试名以TestPortsmithJudge开头");
  if (
    judge.some(
      (f) => f.name === "go.mod" || f.name === "go.sum" || f.name === "LICENSE",
    )
  )
    throw new Error("judge不能覆盖依赖或许可证");
  const root = path.resolve(o.out);
  await mkdir(path.dirname(root), { recursive: true });
  await mkdir(root);
  await mkdir(path.join(root, "candidate"));
  await copyFiles(path.join(root, "references"), refs);
  await writeFile(path.join(root, "RULEBOOK.md"), rules);
  await writeFile(path.join(root, "candidate/go.mod"), mod);
  if (sum) await writeFile(path.join(root, "candidate/go.sum"), sum);
  await writeFile(
    path.join(root, "candidate/LICENSE"),
    refs.find((f) => f.name === "LICENSE")!.data,
  );
  if (judge.length) await copyFiles(path.join(root, "judge"), judge);
  const task: PortTask = {
    version: 1,
    revision: o.revision,
    goal: o.goal,
    example: o.example,
    unit: o.unit,
    planDigest: o.planDigest,
    dependsOn: o.dependsOn ?? [],
    files: refs.map((f) => ({
      path: f.name,
      sha256: hash(f.data),
      bytes: f.data.length,
    })),
    rulesSha256: hash(rules),
    goModSha256: hash(mod),
    goSumSha256: sum && hash(sum),
    judgeFiles: judge.map(({ name, sha256 }) => ({ name, sha256 })),
  };
  await atomicJson(path.join(root, "task.json"), task);
  return root;
}
export async function loadTask(rootInput: string) {
  const root = await realpath(rootInput);
  const task = await readJson<PortTask>(root, "task.json");
  if (
    task.version !== 1 ||
    typeof task.goal !== "string" ||
    !Array.isArray(task.files) ||
    task.files.length > 80 ||
    !task.rulesSha256 ||
    !Array.isArray(task.judgeFiles) ||
    (task.example && task.example !== "event-stream")
  )
    throw new Error("无效任务；旧原型任务需要重新prepare");
  for (const f of task.files) {
    const data = await readFile(
      await checkedFile(root, `references/${f.path}`),
    );
    if (data.length !== f.bytes || hash(data) !== f.sha256)
      throw new Error(`参考快照发生变化：${f.path}`);
  }
  for (const [name, digest] of [
    ["RULEBOOK.md", task.rulesSha256],
    ["candidate/go.mod", task.goModSha256],
    ...(task.goSumSha256 ? [["candidate/go.sum", task.goSumSha256]] : []),
  ])
    if (hash(await readFile(await checkedFile(root, name))) !== digest)
      throw new Error(`冻结配置发生变化：${name}；请重新prepare`);
  for (const f of task.judgeFiles)
    if (
      hash(await readFile(await checkedFile(root, `judge/${f.name}`))) !==
      f.sha256
    )
      throw new Error(`judge发生变化：${f.name}`);
  if ((await lstat(path.join(root, "candidate"))).isSymbolicLink())
    throw new Error("候选目录不能是符号链接");
  return { root, task };
}
export async function writeCandidate(
  root: string,
  name: string,
  content: string,
) {
  relativeName(name);
  if (
    (!/^[a-z0-9_/-]+\.go$/.test(name) && name !== "NOTES.md") ||
    name
      .split("/")
      .some(
        (p) => p.startsWith("port_oracle") || p.startsWith("portsmith_judge"),
      )
  )
    throw new Error("只能写候选Go文件或NOTES.md，不能修改独立验证器");
  if (Buffer.byteLength(content) > 256 * 1024)
    throw new Error("单文件过大，请拆分");
  const { task } = await loadTask(root);
  if (task.judgeFiles.some((f) => f.name === name))
    throw new Error("不能覆盖独立验证器路径");
  if (
    name.endsWith(".go") &&
    !/^\s*package\s+[A-Za-z_]\w*\s*(?:\r?\n|;)/m.test(content)
  )
    throw new Error(
      "Go文件必须包含package声明；write_candidate需要完整文件，局部修改请用edit_candidate",
    );
  const candidate = path.join(root, "candidate");
  let dir = candidate;
  for (const part of name.split("/").slice(0, -1)) {
    dir = path.join(dir, part);
    await mkdir(dir, { recursive: true });
    if ((await lstat(dir)).isSymbolicLink()) throw new Error("不允许符号链接");
  }
  const file = path.join(candidate, name);
  try {
    if ((await lstat(file)).isSymbolicLink() || !(await lstat(file)).isFile())
      throw new Error("目标不是普通文件");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if ((await candidateFiles(root)).length >= 200)
    throw new Error("候选文件过多");
  const temp = path.join(root, `.candidate-${randomUUID()}.tmp`);
  await writeFile(temp, content, { flag: "wx", mode: 0o600 });
  try {
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function editCandidate(
  root: string,
  name: string,
  oldText: string,
  newText: string,
) {
  if (!oldText) throw new Error("oldText不能为空");
  const text = await readFile(
    await checkedFile(path.join(root, "candidate"), name),
    "utf8",
  );
  const index = text.indexOf(oldText);
  if (index < 0 || text.indexOf(oldText, index + 1) >= 0)
    throw new Error("oldText必须在文件中精确出现一次；先重新读取文件");
  await writeCandidate(
    root,
    name,
    text.slice(0, index) + newText + text.slice(index + oldText.length),
  );
}
export async function candidateFiles(root: string) {
  return snapshotFiles(path.join(root, "candidate"));
}
export async function fingerprint(root: string) {
  const { task } = await loadTask(root);
  const files = await candidateFiles(root);
  if (!task.goSumSha256 && files.some((f) => f.name === "go.sum"))
    throw new Error("go.sum不在冻结依赖清单中，请重新prepare");
  return hash(
    JSON.stringify({
      task,
      files: files.map(({ name, sha256 }) => ({ name, sha256 })),
    }),
  );
}
