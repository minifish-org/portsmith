import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Use the known model's full capacity unless the user supplies a working budget. */
export function modelLimits(
  known: { contextWindow: number; maxTokens: number } | undefined,
  deepseek: boolean,
  env: NodeJS.ProcessEnv = process.env,
) {
  const integer = (name: string, fallback: number) => {
    if (env[name] === undefined) return fallback;
    const raw = env[name]!.trim(),
      value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1)
      throw Error(`${name} must be a positive integer`);
    return value;
  };
  const contextWindow = integer(
    "PORTSMITH_CONTEXT_WINDOW",
    known?.contextWindow ?? 32768,
  );
  const maxTokens = integer(
    "PORTSMITH_MAX_TOKENS",
    known?.maxTokens ?? (deepseek ? 8192 : 4096),
  );
  if (contextWindow < 8192 || contextWindow > (known?.contextWindow ?? 2000000))
    throw Error(
      "PORTSMITH_CONTEXT_WINDOW must be at least 8192 and within the known model context capacity",
    );
  if (
    maxTokens < 256 ||
    maxTokens >= contextWindow ||
    maxTokens > (known?.maxTokens ?? 393216)
  )
    throw Error(
      "PORTSMITH_MAX_TOKENS must be at least 256, below the working context size, and within the known model output capacity",
    );
  return { contextWindow, maxTokens };
}

export function loadLocalEnv(file?: string) {
  if (file) loadEnvFile(file);
  else if (existsSync(".env")) loadEnvFile(".env");
}
export async function configuredModel() {
  const baseUrl = process.env.PORTSMITH_BASE_URL ?? process.env.OMNI_BASE_URL;
  const id = process.env.PORTSMITH_MODEL ?? process.env.OMNI_MODEL;
  const key = process.env.PORTSMITH_API_KEY ?? process.env.OMNI_API_KEY;
  if (!baseUrl || !id)
    throw new Error(
      "Set PORTSMITH_BASE_URL and PORTSMITH_MODEL, or load existing OMNI_* settings with --env-file",
    );
  const url = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Model URL must use HTTP(S) without embedded credentials");
  const deepseek = url.hostname === "api.deepseek.com";
  if (deepseek && !key?.trim()) throw new Error("Missing PORTSMITH_API_KEY");
  const config = path.resolve(".portsmith/runtime");
  await mkdir(config, { recursive: true, mode: 0o700 });
  const runtime = await ModelRuntime.create({
    authPath: path.join(config, "auth.json"),
    modelsPath: path.join(config, "models.json"),
    modelsStorePath: path.join(config, "models-store.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const known = deepseek ? runtime.getModel("deepseek", id) : undefined;
  const limits = modelLimits(known, deepseek);
  if (key) process.env.PORTSMITH_RUNTIME_API_KEY = key;
  runtime.registerProvider("portsmith-compatible", {
    baseUrl: baseUrl.replace(/\/$/, ""),
    api: "openai-completions",
    apiKey: key ? "$PORTSMITH_RUNTIME_API_KEY" : "local-no-key",
    models: [
      {
        id,
        name: id,
        reasoning: known?.reasoning ?? deepseek,
        input: ["text"],
        ...limits,
        ...(known?.thinkingLevelMap
          ? { thinkingLevelMap: known.thinkingLevelMap }
          : {}),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          ...known?.compat,
          supportsDeveloperRole: false,
          supportsStore: false,
          maxTokensField: "max_tokens",
          ...(deepseek ? { thinkingFormat: "deepseek" as const } : {}),
        },
      },
    ],
  });
  const model = runtime.getModel("portsmith-compatible", id);
  if (!model) throw new Error("Unable to initialize model");
  return { runtime, model };
}
