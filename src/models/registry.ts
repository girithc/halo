import { OpenAICompatibleProvider } from "./providers/openai-compatible";
import type { ModelConfig, ModelProvider } from "./types";

/** Friendly names for common OpenAI-compatible backends. */
export const MODEL_PRESETS: Record<string, ModelConfig> = {
  deepseek: { id: "deepseek-chat", baseURL: "https://api.deepseek.com/v1" },
  openai: { id: "gpt-4o-mini", baseURL: "https://api.openai.com/v1" },
  openrouter: { id: "openai/gpt-4o-mini", baseURL: "https://openrouter.ai/api/v1" },
  groq: { id: "llama-3.3-70b-versatile", baseURL: "https://api.groq.com/openai/v1" },
  ollama: { id: "llama3.2", baseURL: "http://localhost:11434/v1" },
};

export const DEFAULT_MODEL: ModelConfig = MODEL_PRESETS.deepseek!;

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

  /** Switch the model id, keeping the same base URL. */
  setModelId(id: string): void {
    this.#override = { ...this.active(), id };
  }

  /** Switch to a full config (e.g. a preset with its own base URL). */
  setConfig(config: ModelConfig): void {
    this.#override = config;
  }

  createProvider(apiKey: string): ModelProvider {
    return new OpenAICompatibleProvider(this.active(), apiKey);
  }
}
