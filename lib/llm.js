/**
 * Thin wrapper around a free, OpenAI-compatible LLM endpoint.
 * Supports Groq (default) and NVIDIA NIM — both offer free API tiers and speak
 * the OpenAI chat-completions protocol, so the same code path works for either.
 *
 * Configure via env (.env.local):
 *   GROQ_API_KEY / NVIDIA_API_KEY
 *
 * Interactive requests always pass the model/provider chosen in the frontend.
 * LLM_PROVIDER and LLM_MODEL are only optional fallbacks for scripts or callers
 * that do not supply an explicit model.
 */
import { readResponseText } from "./safeFetch.js";

const PROVIDERS = {
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    defaultModel: "qwen/qwen3.8-27b",
  },
  nvidia: {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    keyEnv: "NVIDIA_API_KEY",
    defaultModel: "meta/llama-3.1-8b-instruct",
  },
};

/**
 * Resolve the effective provider/model/key for a request.
 * If `override` names a specific model (and optionally provider), use it — this is
 * what the Paper → Venue model dropdown sends. Otherwise fall back to env config.
 */
export function llmConfig(override = {}) {
  let provider = (override.provider || process.env.LLM_PROVIDER || "groq").toLowerCase();
  if (!PROVIDERS[provider]) provider = "groq";
  let p = PROVIDERS[provider];
  let apiKey = process.env[p.keyEnv];

  // For the default model only, transparently use whichever configured provider
  // is available. Explicit dropdown choices still require their own provider key.
  if (!override.provider && !apiKey) {
    const fallbackName = Object.keys(PROVIDERS).find((name) => process.env[PROVIDERS[name].keyEnv]);
    if (fallbackName) {
      provider = fallbackName;
      p = PROVIDERS[provider];
      apiKey = process.env[p.keyEnv];
    }
  }

  let baseUrl = p.baseUrl;
  if (process.env.ALLOW_CUSTOM_LLM_BASE_URL === "1" && process.env.LLM_BASE_URL) {
    try {
      const custom = new URL(process.env.LLM_BASE_URL);
      if (custom.protocol !== "https:" || custom.username || custom.password) throw new Error("unsafe custom URL");
      baseUrl = custom.toString().replace(/\/$/, "");
    } catch {
      throw new Error("LLM_BASE_URL must be a credential-free HTTPS URL.");
    }
  }
  const model = override.model || process.env.LLM_MODEL || p.defaultModel;
  return { provider, apiKey, baseUrl, model, keyEnv: p.keyEnv };
}

export function llmReady(override = {}) {
  return Boolean(llmConfig(override).apiKey);
}

/**
 * Chat completion. Set json=true to request a JSON object back.
 * Pass { model, provider, bodyExtra } to target a specific model (dropdown).
 * Returns the raw string content of the first choice.
 */
export async function chat(
  messages,
  { json = false, temperature = 0.2, maxTokens = 1800, model, provider, bodyExtra } = {}
) {
  const cfg = llmConfig({ model, provider });
  const { apiKey, baseUrl, keyEnv } = cfg;
  if (!apiKey) {
    throw new Error(
      `LLM not configured for ${cfg.provider}. Set ${keyEnv}, or choose a model whose provider key is configured.`
    );
  }
  const body = {
    model: cfg.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    ...(bodyExtra || {}),
  };
  if (json) body.response_format = { type: "json_object" };

  const timeoutMs = Math.min(300000, Math.max(10000, Number(process.env.LLM_TIMEOUT_MS || 180000)));
  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(`The ${cfg.provider} model did not respond within ${Math.round(timeoutMs / 1000)} seconds. Choose a faster model or increase LLM_TIMEOUT_MS.`);
    }
    throw error;
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`The ${cfg.provider} model request failed (HTTP ${res.status}).`);
  }
  let data;
  try {
    data = JSON.parse(await readResponseText(res, 2 * 1024 * 1024));
  } catch {
    throw new Error(`The ${cfg.provider} model returned an invalid or oversized response.`);
  }
  return data?.choices?.[0]?.message?.content ?? "";
}

/** Parse a JSON object out of an LLM response, tolerating code fences / prose. */
export function parseJSONLoose(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}
