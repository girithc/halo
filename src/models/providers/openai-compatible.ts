import type {
  ChatChunk,
  ChatMessage,
  ModelConfig,
  ModelProvider,
} from "../types";

/**
 * Works with any OpenAI-compatible chat endpoint:
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
      throw new Error(
        `${this.config.id}: ${await describeError(res)}`,
      );
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // Provider ignored `stream: true` — fall back to one whole reply.
      const json = (await res.json()) as CompletionResponse;
      if (json.error) throw new Error(json.error.message ?? "stream error");
      const content = json.choices?.[0]?.message?.content;
      if (content) yield { delta: content };
      return;
    }

    if (!res.body) throw new Error(`${this.config.id}: empty response body`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          const chunk = parseSseLine(line);
          if (chunk === null) continue;
          if (chunk === "done") return;
          yield chunk;
        }
      }
    } finally {
      reader.releaseLock();
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

/** Parse one SSE line; returns null for irrelevant lines. */
function parseSseLine(line: string): ChatChunk | "done" | null {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (!data) return null;
  if (data === "[DONE]") return "done";
  try {
    const json = JSON.parse(data) as CompletionResponse;
    if (json.error) throw new Error(json.error.message ?? "stream error");
    const delta = json.choices?.[0]?.delta?.content;
    return delta ? { delta } : null;
  } catch (err) {
    if (err instanceof Error && err.message !== "Unexpected end of JSON input") {
      if (!(err instanceof SyntaxError)) throw err;
    }
    return null; // partial or unparsable fragment — skip it
  }
}

async function describeError(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const json = JSON.parse(body) as CompletionResponse & { message?: string };
    return json.error?.message ?? json.message ?? `HTTP ${res.status} ${res.statusText}`;
  } catch {
    return body ? body.slice(0, 300) : `HTTP ${res.status} ${res.statusText}`;
  }
}
