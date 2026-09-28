import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { loadEnvFile } from "node:process";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

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
  if (key) process.env.PORTSMITH_RUNTIME_API_KEY = key;
  runtime.registerProvider("portsmith-compatible", {
    baseUrl: baseUrl.replace(/\/$/, ""),
    api: "openai-completions",
    apiKey: key ? "$PORTSMITH_RUNTIME_API_KEY" : "local-no-key",
    models: [
      {
        id,
        name: id,
        reasoning: deepseek,
        input: ["text"],
        contextWindow: 32768,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
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
