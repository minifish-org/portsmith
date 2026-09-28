import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runPort } from "../src/agent.js";
import {
  candidateFiles,
  loadTask,
  prepareTask,
  writeCandidate,
} from "../src/workspace.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), "omni-port-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "source");
  await mkdir(source);
  await writeFile(path.join(source, "unit.ts"), "export const answer = 42;\n");
  await writeFile(path.join(source, "LICENSE"), "MIT fixture\n");
  const root = await prepareTask({
    source,
    out: path.join(directory, "task"),
    files: ["unit.ts"],
    revision: "fixture",
    goal: "port the constant",
  });
  return { directory, source, root };
}

test("port freezes references and rejects changed snapshots", async (t) => {
  const { source, root } = await fixture(t);
  await writeFile(path.join(source, "unit.ts"), "new upstream\n");
  await loadTask(root);
  assert.match(
    await readFile(path.join(root, "references/unit.ts"), "utf8"),
    /42/,
  );
  await writeFile(path.join(root, "references/unit.ts"), "changed snapshot\n");
  await assert.rejects(loadTask(root), /快照发生变化/);
});

test("port rejects traversal, symlinks, and writes to control files", async (t) => {
  const { directory, source, root } = await fixture(t);
  await symlink(path.join(source, "unit.ts"), path.join(source, "linked.ts"));
  await assert.rejects(
    prepareTask({
      source,
      out: path.join(directory, "bad"),
      files: ["linked.ts"],
      goal: "x",
      revision: "x",
    }),
    /符号链接/,
  );
  for (const name of [
    "../unit.go",
    "go.mod",
    "task.json",
    "port_oracle_test.go",
    "/tmp/unit.go",
  ]) {
    await assert.rejects(writeCandidate(root, name, "bad"));
  }
  await symlink(
    path.join(source, "unit.ts"),
    path.join(root, "candidate/unit.go"),
  );
  await assert.rejects(writeCandidate(root, "unit.go", "bad"));
  assert.match(await readFile(path.join(source, "unit.ts"), "utf8"), /42/);
});

test(
  "real Pi SDK reads only selected references and writes a candidate through a local model fixture",
  { timeout: 20000 },
  async (t) => {
    const { directory, root } = await fixture(t);
    const requests: any[] = [];
    const toolCalls = [
      { name: "read_reference", arguments: { path: "unit.ts" } },
      {
        name: "write_candidate",
        arguments: { path: "../escape.go", content: "must not write" },
      },
      {
        name: "write_candidate",
        arguments: {
          path: "answer.go",
          content: "package port\nconst Answer = 42\n",
        },
      },
    ];
    const server = createServer((request, response) => {
      void (async () => {
        const chunks = [];
        for await (const c of request) chunks.push(c);
        requests.push(JSON.parse(Buffer.concat(chunks).toString()));
        const call = toolCalls[requests.length - 1];
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: unknown, finish: string | null = null) =>
          response.write(
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
          );
        chunk({ role: "assistant" });
        if (call) {
          chunk({
            tool_calls: [
              {
                index: 0,
                id: `call-${requests.length}`,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              },
            ],
          });
          chunk({}, "tool_calls");
        } else {
          chunk({ content: "候选生成，尚未验证。" });
          chunk({}, "stop");
        }
        response.end("data: [DONE]\n\n");
      })().catch(() => {
        response.statusCode = 500;
        response.end();
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const runtime = await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: path.join(directory, "models.json"),
      modelsStorePath: path.join(directory, "models-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    runtime.registerProvider("fixture", {
      api: "openai-completions",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "fixture-key",
      models: [
        {
          id: "fixture",
          name: "fixture",
          reasoning: false,
          input: ["text"],
          contextWindow: 32768,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
    const model = runtime.getModel("fixture", "fixture");
    assert.ok(model);
    const report = await runPort({
      root,
      runtime,
      model,
      maxTurns: 6,
      timeoutMs: 15000,
    });
    assert.equal(report.status, "candidate_ready");
    assert.equal(report.turns, 4);
    assert.deepEqual(
      requests[0].tools.map((t: any) => t.function.name).sort(),
      ["edit_candidate", "read_candidate", "read_reference", "write_candidate"],
    );
    assert.match(JSON.stringify(requests[1].messages), /answer = 42/);
    assert.match(JSON.stringify(requests[2].messages), /非法相对路径/);
    assert.match(
      (await candidateFiles(root))
        .find((f) => f.name === "answer.go")!
        .data.toString(),
      /Answer = 42/,
    );
  },
);
