import { MetaProvider } from "./providers/meta";
import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import type { ModelConfig, ModelProvider } from "./types";

/** Friendly names for common backends. */
export const MODEL_PRESETS: Record<string, ModelConfig> = {
  deepseek: {
    name: "deepseek",
    id: "deepseek-chat",
    baseURL: "https://api.deepseek.com/v1",
    apiKeyEnv: ["DEEPSEEK_API_KEY"],
  },
  meta: {
    name: "meta",
    id: "muse-spark-1.3-contributor",
    baseURL: "https://api.meta.ai/v1",
    api: "responses",
    apiKeyEnv: ["META_API_KEY", "MODEL_API_KEY"],
    reasoningEffort: "medium",
  },
  openai: {
    name: "openai",
    id: "gpt-4o-mini",
    baseURL: "https://api.openai.com/v1",
    apiKeyEnv: ["OPENAI_API_KEY"],
  },
  openrouter: {
    name: "openrouter",
    id: "openai/gpt-4o-mini",
    baseURL: "https://openrouter.ai/api/v1",
    apiKeyEnv: ["OPENROUTER_API_KEY"],
  },
  groq: {
    name: "groq",
    id: "llama-3.3-70b-versatile",
    baseURL: "https://api.groq.com/openai/v1",
    apiKeyEnv: ["GROQ_API_KEY"],
  },
  ollama: {
    name: "ollama",
    id: "llama3.2",
    baseURL: "http://localhost:11434/v1",
    apiKeyEnv: [], // local — no key needed
  },
};

/** Popular model ids per provider, offered by the first-run wizard. */
export const PROVIDER_MODELS: Record<string, string[]> = {
  deepseek: ["deepseek-chat", "deepseek-reasoner"],
  meta: ["muse-spark-1.3-contributor"],
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1", "gpt-4.1-mini"],
  openrouter: [
    "openai/gpt-4o-mini",
    "anthropic/claude-sonnet-4",
    "deepseek/deepseek-chat",
    "meta-llama/llama-3.3-70b-instruct",
  ],
  groq: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  ollama: ["llama3.2", "qwen2.5-coder"],
};

export const DEFAULT_MODEL: ModelConfig = MODEL_PRESETS.deepseek!;

/** True when the provider needs a key (local runtimes like Ollama don't). */
export function needsApiKey(config: ModelConfig): boolean {
  return config.apiKeyEnv === undefined || config.apiKeyEnv.length > 0;
}

/**
 * Knows which model is active right now and hands out providers for it.
 * Resolution order: session override (/model) -> stored config -> default.
 */
export class ModelRegistry {
  #base: ModelConfig;
  #override: ModelConfig | null = null;

  constructor(base: ModelConfig = DEFAULT_MODEL) {
    this.#base = base;
  }

  active(): ModelConfig {
    return this.#override ?? this.#base;
  }

  /** Switch the model id, keeping the same base URL and protocol. */
  setModelId(id: string): void {
    this.#override = { ...this.active(), id };
  }

  /** Switch to a full config (e.g. a preset with its own protocol). */
  setConfig(config: ModelConfig): void {
    this.#override = config;
  }

  createProvider(apiKey: string): ModelProvider {
    const config = this.active();
    return config.api === "responses"
      ? new MetaProvider(config, apiKey)
      : new OpenAICompatibleProvider(config, apiKey);
  }
}
