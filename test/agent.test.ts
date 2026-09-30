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
import { modelLimits } from "../src/model.js";
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
    judgeFiles: [
      {
        name: "portsmith_judge_fixture_test.go",
        data: Buffer.from(
          'package port\n// frozen-fixture-marker\nimport "testing"\nfunc TestPortsmithJudgeFixture(t *testing.T){}\n',
        ),
      },
    ],
  });
  const agentDir = path.join(directory, "pi-agent");
  await mkdir(agentDir);
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ retry: { enabled: false } }),
  );
  return { directory, source, root, agentDir };
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
  await assert.rejects(loadTask(root), /snapshot changed/);
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
    /Symbolic links/,
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
  "native Pi tools compile, repair, verify and resume the same persistent conversation",
  { timeout: 20000 },
  async (t) => {
    const { directory, root, agentDir } = await fixture(t);
    await mkdir(path.join(agentDir, "skills", "fixture-skill"), {
      recursive: true,
    });
    await writeFile(
      path.join(agentDir, "skills", "fixture-skill", "SKILL.md"),
      "---\nname: fixture-skill\ndescription: fixture-skill-discovery-marker\n---\nUse this fixture skill for tests.\n",
    );
    await mkdir(path.join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      path.join(agentDir, "extensions", "fixture.ts"),
      'export default function(pi){pi.registerTool({name:"fixture_extension",label:"Fixture extension",description:"fixture extension",parameters:{type:"object",properties:{}},async execute(){return {content:[{type:"text",text:"fixture-extension-result"}],details:{}};}})}',
    );
    const requests: any[] = [];
    const toolCalls = [
      { name: "read", arguments: { path: "../references/unit.ts" } },
      {
        name: "write",
        arguments: {
          path: "answer.go",
          content: "package port\nconst Answer = missingValue\n",
        },
      },
      {
        name: "write",
        arguments: {
          path: "answer_test.go",
          content:
            'package port\nimport "testing"\nfunc TestAnswer(t *testing.T){if Answer != 42 {t.Fatal("wrong answer")}}\n',
        },
      },
      { name: "verify_candidate", arguments: {} },
      {
        name: "edit",
        arguments: {
          path: "answer.go",
          oldText: "missingValue",
          newText: "41",
        },
      },
      { name: "verify_candidate", arguments: {} },
      {
        name: "edit",
        arguments: { path: "answer.go", oldText: "41", newText: "42" },
      },
      {
        name: "bash",
        arguments: { command: "go test -mod=readonly -p=1 ./..." },
      },
      {
        name: "grep",
        arguments: { pattern: "Answer", path: ".", glob: "*.go" },
      },
      { name: "find", arguments: { pattern: "*.go", path: "." } },
      { name: "ls", arguments: { path: "." } },
      {
        name: "read",
        arguments: { path: "../judge/portsmith_judge_fixture_test.go" },
      },
      { name: "verify_candidate", arguments: {} },
    ];
    toolCalls.push({ name: "fixture_extension", arguments: {} });
    await writeFile(
      path.join(root, "verification.json"),
      JSON.stringify({
        status: "behavior_failed",
        phases: [
          { name: "compile", result: { code: 0, log: "passed".repeat(5000) } },
          {
            name: "independent-behavior",
            result: {
              code: 1,
              log: [
                JSON.stringify({
                  ImportPath: "fixture/telemetry",
                  Action: "build-output",
                  Output:
                    "telemetry/index.go:167:19: invalid operation: ok == nil (mismatched types bool and untyped nil)\n",
                }),
                JSON.stringify({
                  Action: "build-fail",
                  ImportPath: "fixture/telemetry",
                }),
                JSON.stringify({
                  Action: "output",
                  Output: "fixture-actionable-error\n",
                }),
                "plain-vet-diagnostic",
              ].join("\n"),
            },
          },
        ],
      }),
    );
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
          chunk({ content: "Candidate generated, not yet verified." });
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
      agentDir,
    });
    assert.equal(report.status, "candidate_ready");
    assert.equal(report.turns, toolCalls.length + 1);
    const initial = JSON.stringify(requests[0].messages);
    assert.match(initial, /fixture-actionable-error/);
    assert.match(
      initial,
      /telemetry\/index.go:167:19: invalid operation: ok == nil/,
    );
    assert.match(initial, /FAIL fixture\/telemetry/);
    assert.match(initial, /plain-vet-diagnostic/);
    assert.doesNotMatch(initial, /passedpassed/);
    assert.doesNotMatch(initial, /tools do not provide command execution/);
    assert.match(initial, /fixture-skill-discovery-marker/);
    assert.deepEqual(
      requests[0].tools.map((t: any) => t.function.name).sort(),
      [
        "bash",
        "edit",
        "find",
        "fixture_extension",
        "grep",
        "ls",
        "read",
        "verify_candidate",
        "write",
      ],
    );
    assert.match(JSON.stringify(requests[1].messages), /answer = 42/);
    const toolResult = (request: number, name: string) =>
      requests[request].messages.findLast((m: any) => m.role === "tool")
        ?.content;
    assert.match(toolResult(4, "verify_candidate"), /undefined: missingValue/);
    assert.match(toolResult(6, "verify_candidate"), /tests_failed/);
    assert.match(toolResult(8, "bash"), /ok/);
    assert.match(toolResult(9, "grep"), /Answer/);
    assert.match(toolResult(10, "find"), /answer.go/);
    assert.match(toolResult(11, "ls"), /answer_test.go/);
    assert.match(toolResult(12, "read"), /frozen-fixture-marker/);
    assert.match(toolResult(13, "verify_candidate"), /behavior_verified/);
    assert.match(
      toolResult(14, "fixture_extension"),
      /fixture-extension-result/,
    );
    const verified = JSON.parse(
      await readFile(path.join(root, "verification.json"), "utf8"),
    );
    assert.equal(verified.status, "behavior_verified");
    assert.ok(
      verified.phases.some((p: any) => p.name === "independent-behavior"),
    );
    assert.equal(report.resumed, false);
    assert.ok(report.sessionFile);
    assert.match(await readFile(report.sessionFile, "utf8"), /missingValue/);
    const followup = await runPort({
      root,
      runtime,
      model,
      agentDir,
      feedback: "resume-marker",
    });
    assert.equal(followup.resumed, true);
    assert.equal(followup.sessionFile, report.sessionFile);
    const resumedRequest = JSON.stringify(requests.at(-1).messages);
    assert.match(resumedRequest, /resume-marker/);
    assert.match(resumedRequest, /undefined: missingValue/);
    assert.match(resumedRequest, /behavior_verified/);
    const legacy = await fixture(t);
    await writeFile(
      path.join(legacy.root, "run-1000.jsonl"),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "user",
          content: [{ type: "text", text: "legacy-session-marker" }],
          timestamp: 1,
        },
      }) + "\n",
    );
    const imported = await runPort({
      root: legacy.root,
      runtime,
      model,
      agentDir: legacy.agentDir,
    });
    assert.equal(imported.resumed, true);
    assert.match(
      JSON.stringify(requests.at(-1).messages),
      /legacy-session-marker/,
    );
    assert.match(
      await readFile(imported.sessionFile!, "utf8"),
      /legacy-session-marker/,
    );
    assert.match(
      (await candidateFiles(root))
        .find((f) => f.name === "answer.go")!
        .data.toString(),
      /Answer = 42/,
    );
  },
);

for (const scenario of [
  "resume-text",
  "resume-tool",
  "repeated",
  "turn-bound",
  "cancel",
  "api-error",
]) {
  test(`model length recovery: ${scenario}`, { timeout: 20000 }, async (t) => {
    const { root, directory, agentDir } = await fixture(t);
    const requests: any[] = [],
      progress: string[] = [];
    const controller = new AbortController();
    const server = createServer((req, res) => {
      void (async () => {
        const chunks = [];
        for await (const b of req) chunks.push(b);
        const request = JSON.parse(Buffer.concat(chunks).toString());
        requests.push(request);
        if (scenario === "api-error") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: {
                message: "fixture denied",
                type: "authentication_error",
              },
            }),
          );
          return;
        }
        if (requests.length === 2 && scenario === "resume-tool") {
          // A length-truncated tool call must never overwrite even a preexisting file.
          assert.equal(
            await readFile(path.join(root, "candidate/answer.go"), "utf8"),
            "package port\nconst Answer = 42\n",
          );
        }
        const tool = (content: string) => ({
          tool_calls: [
            {
              index: 0,
              id: `call-${requests.length}`,
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: "answer.go", content }),
              },
            },
          ],
        });
        const truncated =
          requests.length === 1 ||
          ["repeated", "turn-bound", "cancel"].includes(scenario);
        const delta = truncated
          ? scenario === "resume-tool"
            ? tool("package port\nconst Answer = 0\n")
            : { content: "unfinished analysis" }
          : requests.length === 2
            ? tool("package port\nconst Answer = 42\n")
            : { content: "candidate saved" };
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: unknown, finish: unknown) =>
          res.write(
            `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
          );
        chunk({ role: "assistant" }, null);
        chunk(delta, null);
        chunk(
          {},
          truncated ? "length" : requests.length === 2 ? "tool_calls" : "stop",
        );
        res.end("data: [DONE]\n\n");
      })().catch((e) => {
        res.destroy(e);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    });
    const address = server.address();
    assert(address && typeof address !== "string");
    const runtime = await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: path.join(directory, "models.json"),
      modelsStorePath: path.join(directory, "models-store.json"),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const limits = modelLimits(
      { contextWindow: 1000000, maxTokens: 384000 },
      true,
      {},
    );
    runtime.registerProvider("fixture", {
      api: "openai-completions",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "fixture-key",
      models: [
        {
          id: "fixture",
          name: "fixture",
          reasoning: true,
          input: ["text"],
          ...limits,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat: {
            maxTokensField: "max_tokens",
            thinkingFormat: "deepseek",
            supportsStore: false,
            supportsDeveloperRole: false,
          },
        },
      ],
    });
    const model = runtime.getModel("fixture", "fixture");
    assert(model);
    if (scenario === "resume-tool")
      await writeCandidate(
        root,
        "answer.go",
        "package port\nconst Answer = 42\n",
      );
    const report = await runPort({
      root,
      runtime,
      model,
      agentDir,
      maxTurns: scenario === "turn-bound" ? 1 : 8,
      timeoutMs: 15000,
      signal: controller.signal,
      onProgress: (line) => {
        progress.push(line);
        if (scenario === "cancel" && line.includes("preserved context"))
          controller.abort();
      },
    });
    assert.equal(requests[0].max_tokens, 384000);
    assert.deepEqual(requests[0].thinking, { type: "enabled" });
    if (scenario.startsWith("resume")) {
      assert.equal(report.status, "candidate_ready");
      assert.equal(report.outputContinuations, 1);
      assert.equal(requests.length, 3);
      assert.match(
        JSON.stringify(requests[1].messages),
        /previous response reached the output limit/,
      );
      if (scenario === "resume-text")
        assert.match(
          JSON.stringify(requests[1].messages),
          /unfinished analysis/,
        );
      assert.match(
        await readFile(path.join(root, "candidate/answer.go"), "utf8"),
        /Answer = 42/,
      );
    } else if (scenario === "api-error") {
      assert.equal(report.status, "model_error");
      assert.equal(requests.length, 1);
      assert.match(report.error!, /fixture denied|401/);
    } else if (scenario === "cancel") {
      assert.equal(report.status, "cancelled");
      assert.equal(requests.length, 1);
    } else {
      assert.equal(report.status, "output_limit", JSON.stringify(report));
      assert.equal(requests.length, scenario === "turn-bound" ? 1 : 8);
      assert.match(report.error!, /finish_reason=length.*384000/);
      assert.equal(
        report.outputContinuations,
        scenario === "turn-bound" ? 0 : 7,
      );
    }
    assert.equal(
      JSON.parse(await readFile(path.join(root, "last-run.json"), "utf8"))
        .status,
      report.status,
    );
  });
}
