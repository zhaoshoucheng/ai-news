/**
 * API 模型列表抓取模块
 * 从各厂商官方 API 获取当前可用模型列表
 * 用于与历史快照对比，检测新增/移除/变更
 */

import type { ProviderConfig, ModelInfo, ModelSnapshot } from "./types.js";

/**
 * 从 OpenAI API 获取模型列表
 */
async function fetchOpenAIModels(apiKey: string): Promise<ModelInfo[]> {
  try {
    const resp = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      console.warn(`[API] OpenAI models API returned ${resp.status}`);
      return [];
    }
    const data = await resp.json() as { data: Array<{ id: string; created: number; owned_by: string }> };
    return (data.data ?? []).map((m) => ({
      id: m.id,
      created: m.created,
      owned_by: m.owned_by,
    }));
  } catch (err: any) {
    console.warn(`[API] OpenAI fetch failed: ${err.message}`);
    return [];
  }
}

/**
 * 从 Anthropic API 获取模型列表
 */
async function fetchAnthropicModels(apiKey: string): Promise<ModelInfo[]> {
  try {
    const resp = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      console.warn(`[API] Anthropic models API returned ${resp.status}`);
      return [];
    }
    const data = await resp.json() as { data: Array<{ id: string; display_name?: string; created_at?: string; type?: string }> };
    return (data.data ?? []).map((m) => ({
      id: m.id,
      name: m.display_name,
      created: m.created_at ? Math.floor(new Date(m.created_at).getTime() / 1000) : undefined,
    }));
  } catch (err: any) {
    console.warn(`[API] Anthropic fetch failed: ${err.message}`);
    return [];
  }
}

/**
 * 从 Google AI API 获取 Gemini 模型列表
 */
async function fetchGeminiModels(apiKey: string): Promise<ModelInfo[]> {
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
      { signal: AbortSignal.timeout(15000) }
    );
    if (!resp.ok) {
      console.warn(`[API] Gemini models API returned ${resp.status}`);
      return [];
    }
    const data = await resp.json() as {
      models: Array<{
        name: string;
        displayName?: string;
        description?: string;
        inputTokenLimit?: number;
        outputTokenLimit?: number;
        supportedGenerationMethods?: string[];
      }>;
    };
    return (data.models ?? []).map((m) => ({
      id: m.name.replace("models/", ""),
      name: m.displayName,
      context_window: m.inputTokenLimit,
      max_output_tokens: m.outputTokenLimit,
      capabilities: m.supportedGenerationMethods,
    }));
  } catch (err: any) {
    console.warn(`[API] Gemini fetch failed: ${err.message}`);
    return [];
  }
}

/**
 * 获取指定 provider 的模型快照
 */
export async function fetchModelsForProvider(
  provider: ProviderConfig
): Promise<ModelSnapshot> {
  let models: ModelInfo[] = [];

  switch (provider.id) {
    case "openai": {
      const key = process.env.OPENAI_OFFICIAL_API_KEY ?? "";
      if (key) {
        models = await fetchOpenAIModels(key);
      } else {
        console.warn(`[API] OPENAI_OFFICIAL_API_KEY not set, skipping OpenAI API fetch`);
      }
      break;
    }
    case "anthropic": {
      const key = process.env.ANTHROPIC_API_KEY ?? "";
      if (key) {
        models = await fetchAnthropicModels(key);
      } else {
        console.warn(`[API] ANTHROPIC_API_KEY not set, skipping Anthropic API fetch`);
      }
      break;
    }
    case "gemini": {
      const key = process.env.GOOGLE_AI_API_KEY ?? "";
      if (key) {
        models = await fetchGeminiModels(key);
      } else {
        console.warn(`[API] GOOGLE_AI_API_KEY not set, skipping Gemini API fetch`);
      }
      break;
    }
  }

  console.log(`[API] ${provider.name}: fetched ${models.length} models`);

  return {
    provider: provider.id,
    fetched_at: new Date().toISOString(),
    models,
  };
}
