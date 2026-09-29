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
      throw Error(`${name} 必须为正整数`);
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
      "PORTSMITH_CONTEXT_WINDOW 必须至少8192且不超过已知模型的上下文容量",
    );
  if (
    maxTokens < 256 ||
    maxTokens >= contextWindow ||
    maxTokens > (known?.maxTokens ?? 393216)
  )
    throw Error(
      "PORTSMITH_MAX_TOKENS 必须至少256、小于工作上下文且不超过已知模型的输出容量",
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
      "请设置PORTSMITH_BASE_URL和PORTSMITH_MODEL，或用--env-file读取原OMNI_*配置",
    );
  const url = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("模型地址必须是无内嵌凭据的HTTP(S)地址");
  const deepseek = url.hostname === "api.deepseek.com";
  if (deepseek && !key?.trim()) throw new Error("缺少PORTSMITH_API_KEY");
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
  if (!model) throw new Error("无法初始化模型");
  return { runtime, model };
}
