import { describeError, sseDataEvents } from "../http";
import type {
  ChatChunk,
  ChatMessage,
  ModelConfig,
  ModelProvider,
} from "../types";

/**
 * Works with any OpenAI-compatible *Chat Completions* endpoint:
 * DeepSeek, OpenAI, OpenRouter, Groq, local Ollama, ...
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly config: ModelConfig;
  #apiKey: string;

  constructor(config: ModelConfig, apiKey: string) {
    this.config = config;
    this.#apiKey = apiKey;
  }

  async *chat(
    messages: readonly ChatMessage[],
    signal: AbortSignal,
  ): AsyncIterable<ChatChunk> {
    const url = `${this.config.baseURL.replace(/\/+$/, "")}/chat/completions`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.id,
        messages,
        stream: true,
      }),
      signal,
    });

    if (!res.ok) {
      throw new Error(`${this.config.id}: ${await describeError(res)}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // Provider ignored `stream: true` — fall back to one whole reply.
      const json = (await res.json()) as CompletionResponse;
      if (json.error) throw new Error(json.error.message ?? "request failed");
      const content = json.choices?.[0]?.message?.content;
      if (content) yield { delta: content };
      return;
    }

    if (!res.body) throw new Error(`${this.config.id}: empty response body`);

    for await (const data of sseDataEvents(res.body)) {
      if (data === "[DONE]") return;
      let json: CompletionResponse;
      try {
        json = JSON.parse(data) as CompletionResponse;
      } catch {
        continue; // partial fragment — skip
      }
      if (json.error) throw new Error(json.error.message ?? "stream error");
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) yield { delta };
    }
  }
}

type CompletionResponse = {
  error?: { message?: string };
  choices?: Array<{
    delta?: { content?: string };
    message?: { content?: string };
  }>;
};
