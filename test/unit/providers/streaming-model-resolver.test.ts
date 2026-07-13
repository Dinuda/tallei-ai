import assert from "node:assert/strict";
import test from "node:test";

import type { Config } from "../../../src/config/load.js";

async function patchConfig(overrides: Partial<Config>): Promise<void> {
  const configModule = await import("../../../src/config/index.js");
  Object.assign(configModule.config, overrides);
}

test("GatewayStreamingResolver uses OpenAI responses API for hosted GPT chat models", async () => {
  const { loadConfig } = await import("../../../src/config/load.js");
  await patchConfig(loadConfig({
    NODE_ENV: "test",
    TALLEI_HTTP__INTERNAL_API_SECRET: "test-secret",
    TALLEI_DB__URL: "postgresql://tallei:tallei@localhost:5432/tallei",
    TALLEI_AUTH__JWT_SECRET: "jwt-secret",
    TALLEI_LLM__LOCAL_MODEL_MODE: "false",
    TALLEI_LLM__PROVIDER: "openai",
    TALLEI_LLM__OPENAI_API_KEY: "sk-test-key",
    TALLEI_LLM__CHAT_MODEL: "gpt-5-mini",
  }));

  const { gatewayStreamingResolver } = await import(
    "../../../src/model/providers/streaming-resolver.js?t=openai-responses"
  );
  const resolved = gatewayStreamingResolver.resolve("chat");
  const model = resolved.model as { provider?: string; modelId?: string };
  assert.equal(model.provider, "openai.responses");
  assert.equal(model.modelId, "gpt-5-mini");
  assert.equal(resolved.modelId, "gpt-5-mini");
  assert.equal(resolved.surface, "responses");
});

test("GatewayStreamingResolver coerces non-hosted OpenAI chat models to default", async () => {
  const { loadConfig } = await import("../../../src/config/load.js");
  await patchConfig(loadConfig({
    NODE_ENV: "test",
    TALLEI_HTTP__INTERNAL_API_SECRET: "test-secret",
    TALLEI_DB__URL: "postgresql://tallei:tallei@localhost:5432/tallei",
    TALLEI_AUTH__JWT_SECRET: "jwt-secret",
    TALLEI_LLM__LOCAL_MODEL_MODE: "false",
    TALLEI_LLM__PROVIDER: "openai",
    TALLEI_LLM__OPENAI_API_KEY: "sk-test-key",
    TALLEI_LLM__CHAT_MODEL: "custom-local-model",
  }));

  const { gatewayStreamingResolver } = await import(
    "../../../src/model/providers/streaming-resolver.js?t=openai-chat"
  );
  const resolved = gatewayStreamingResolver.resolve("chat");
  const model = resolved.model as { provider?: string; modelId?: string };
  assert.equal(model.provider, "openai.responses");
  assert.equal(model.modelId, "gpt-5-nano");
  assert.equal(resolved.modelId, "gpt-5-nano");
  assert.equal(resolved.surface, "responses");
});

test("GatewayStreamingResolver uses OpenCode chat completions when provider is opencode", async () => {
  const { loadConfig } = await import("../../../src/config/load.js");
  await patchConfig(loadConfig({
    NODE_ENV: "test",
    TALLEI_HTTP__INTERNAL_API_SECRET: "test-secret",
    TALLEI_DB__URL: "postgresql://tallei:tallei@localhost:5432/tallei",
    TALLEI_AUTH__JWT_SECRET: "jwt-secret",
    TALLEI_LLM__LOCAL_MODEL_MODE: "false",
    TALLEI_LLM__PROVIDER: "opencode",
    TALLEI_LLM__OPENCODE_API_KEY: "oc-test-key",
    TALLEI_LLM__OPENCODE_MODEL: "big-pickle",
  }));

  const { gatewayStreamingResolver } = await import(
    "../../../src/model/providers/streaming-resolver.js?t=opencode-streaming"
  );
  const resolved = gatewayStreamingResolver.resolve("chat");
  const model = resolved.model as { provider?: string; modelId?: string };
  assert.equal(model.provider, "opencode.chat");
  assert.equal(model.modelId, "big-pickle");
  assert.equal(resolved.surface, "opencode");
});

test("GatewayStreamingResolver resolveToolChoice is provider-aware", async () => {
  const { loadConfig } = await import("../../../src/config/load.js");
  const { GatewayStreamingResolver } = await import(
    "../../../src/model/providers/streaming-resolver.js?t=tool-choice"
  );

  await patchConfig(loadConfig({
    NODE_ENV: "test",
    TALLEI_HTTP__INTERNAL_API_SECRET: "test-secret",
    TALLEI_DB__URL: "postgresql://tallei:tallei@localhost:5432/tallei",
    TALLEI_AUTH__JWT_SECRET: "jwt-secret",
    TALLEI_LLM__LOCAL_MODEL_MODE: "false",
    TALLEI_LLM__PROVIDER: "opencode",
    TALLEI_LLM__OPENCODE_API_KEY: "oc-test-key",
  }));
  const openCodeResolver = new GatewayStreamingResolver();
  assert.equal(openCodeResolver.resolveToolChoice(0), "none");
  assert.equal(openCodeResolver.resolveToolChoice(2), "required");

  await patchConfig(loadConfig({
    NODE_ENV: "test",
    TALLEI_HTTP__INTERNAL_API_SECRET: "test-secret",
    TALLEI_DB__URL: "postgresql://tallei:tallei@localhost:5432/tallei",
    TALLEI_AUTH__JWT_SECRET: "jwt-secret",
    TALLEI_LLM__LOCAL_MODEL_MODE: "false",
    TALLEI_LLM__PROVIDER: "openai",
    TALLEI_LLM__OPENAI_API_KEY: "sk-test-key",
  }));
  const openAiResolver = new GatewayStreamingResolver();
  assert.equal(openAiResolver.resolveToolChoice(2), "required");
  assert.deepEqual(openAiResolver.resolveToolChoice(2, {
    nextTool: "listTriggers",
    allowedTools: ["listTriggers", "resolveBindings"],
  }), { type: "tool", toolName: "listTriggers" });
});

test("GatewayStreamingResolver shouldSendReasoning is enabled for all streaming surfaces", async () => {
  const { GatewayStreamingResolver } = await import(
    "../../../src/model/providers/streaming-resolver.js?t=send-reasoning"
  );
  const resolver = new GatewayStreamingResolver();
  assert.equal(resolver.shouldSendReasoning("responses"), true);
  assert.equal(resolver.shouldSendReasoning("chat"), true);
  assert.equal(resolver.shouldSendReasoning("opencode"), true);
});

test("GatewayStreamingResolver shouldApplyReasoningTagExtraction gates OpenAI responses", async () => {
  const { GatewayStreamingResolver } = await import(
    "../../../src/model/providers/streaming-resolver.js?t=tag-extract"
  );
  const resolver = new GatewayStreamingResolver();
  assert.equal(resolver.shouldApplyReasoningTagExtraction("openai", "responses"), false);
  assert.equal(resolver.shouldApplyReasoningTagExtraction("openai", "chat"), true);
  assert.equal(resolver.shouldApplyReasoningTagExtraction("opencode", "opencode"), true);
  assert.equal(resolver.shouldApplyReasoningTagExtraction("nvidia", "chat"), true);
});

test("GatewayStreamingResolver uses NVIDIA NIM chat when provider is nvidia", async () => {
  const { loadConfig } = await import("../../../src/config/load.js");
  await patchConfig(loadConfig({
    NODE_ENV: "test",
    TALLEI_HTTP__INTERNAL_API_SECRET: "test-secret",
    TALLEI_DB__URL: "postgresql://tallei:tallei@localhost:5432/tallei",
    TALLEI_AUTH__JWT_SECRET: "jwt-secret",
    TALLEI_LLM__LOCAL_MODEL_MODE: "false",
    TALLEI_LLM__PROVIDER: "nvidia",
    TALLEI_LLM__NVIDIA_API_KEY: "nvidia-test-key",
    TALLEI_LLM__NVIDIA_MODEL: "deepseek-ai/deepseek-r1",
  }));

  const { gatewayStreamingResolver } = await import(
    "../../../src/model/providers/streaming-resolver.js?t=nvidia-streaming"
  );
  const resolved = gatewayStreamingResolver.resolve("chat");
  const model = resolved.model as { provider?: string; modelId?: string };
  assert.equal(model.provider, "nim.chat");
  assert.equal(model.modelId, "deepseek-ai/deepseek-r1");
  assert.equal(resolved.surface, "chat");
  assert.equal(resolved.provider, "nvidia");
  assert.equal(gatewayStreamingResolver.resolveToolChoice(2), "required");
});
