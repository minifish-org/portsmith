import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { modelLimits } from "../src/model.js";

test("defaults use full model capacity and validate explicit budget overrides", () => {
  const known = { contextWindow: 1000000, maxTokens: 384000 };
  assert.deepEqual(modelLimits(known, true, {}), {
    contextWindow: 1000000,
    maxTokens: 384000,
  });
  assert.deepEqual(modelLimits(undefined, false, {}), {
    contextWindow: 32768,
    maxTokens: 4096,
  });
  assert.deepEqual(
    modelLimits(known, true, { PORTSMITH_MAX_TOKENS: "65536" }),
    { contextWindow: 1000000, maxTokens: 65536 },
  );
  assert.deepEqual(
    modelLimits({ contextWindow: 16384, maxTokens: 4096 }, true, {}),
    { contextWindow: 16384, maxTokens: 4096 },
  );
  assert.deepEqual(
    modelLimits(known, true, {
      PORTSMITH_MAX_TOKENS: "65536",
      PORTSMITH_CONTEXT_WINDOW: "262144",
    }),
    { contextWindow: 262144, maxTokens: 65536 },
  );
  for (const env of [
    { PORTSMITH_MAX_TOKENS: "NaN" },
    { PORTSMITH_MAX_TOKENS: "0" },
    { PORTSMITH_MAX_TOKENS: "1.5" },
    { PORTSMITH_MAX_TOKENS: "500000" },
    { PORTSMITH_CONTEXT_WINDOW: "8000000" },
    { PORTSMITH_CONTEXT_WINDOW: "1024" },
    { PORTSMITH_CONTEXT_WINDOW: "262144" },
    {
      PORTSMITH_MAX_TOKENS: "131072",
      PORTSMITH_CONTEXT_WINDOW: "131072",
    },
  ])
    assert.throws(() => modelLimits(known, true, env));
});

test("configured DeepSeek Flash uses full pinned catalog capacity without network", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "portsmith-model-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = new URL("../src/model.ts", import.meta.url).href;
  const run = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "-e",
      `const {configuredModel}=await import(${JSON.stringify(source)});const {model}=await configuredModel();console.log(JSON.stringify({id:model.id,maxTokens:model.maxTokens,contextWindow:model.contextWindow,thinkingFormat:model.compat.thinkingFormat}));`,
    ],
    {
      cwd: dir,
      timeout: 20000,
      env: {
        PATH: process.env.PATH,
        HOME: dir,
        PORTSMITH_BASE_URL: "https://api.deepseek.com",
        PORTSMITH_MODEL: "deepseek-flash",
        PORTSMITH_API_KEY: "fixture-not-a-real-key",
      },
    },
  );
  assert.deepEqual(JSON.parse(run.stdout), {
    id: "deepseek-flash",
    maxTokens: 384000,
    contextWindow: 1000000,
    thinkingFormat: "deepseek",
  });
});
