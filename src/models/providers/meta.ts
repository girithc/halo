import { describeError, errorText, sseDataEvents } from "../http";
import type {
  ChatChunk,
  ChatMessage,
  ModelConfig,
  ModelProvider,
} from "../types";

/**
 * Meta's api.meta.ai speaks the OpenAI **Responses** wire protocol:
 * POST {base}/responses with `input`, streamed as typed SSE events
 * (`response.output_text.delta`, `response.completed`, ...).
 */
export class MetaProvider implements ModelProvider {
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
    const url = `${this.config.baseURL.replace(/\/+$/, "")}/responses`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.id,
        input: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      }),
      signal,
    });

    if (!res.ok) {
      throw new Error(`${this.config.id}: ${await describeError(res)}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // Provider ignored `stream: true` — parse a whole Responses payload.
      const json = (await res.json()) as ResponsesEnvelope;
      if (json.error) throw new Error(errorText(json.error) || "request failed");
      for (const item of json.output ?? []) {
        if (item.type !== "message") continue;
        for (const part of item.content ?? []) {
          if (part.type === "output_text" && part.text) yield { delta: part.text };
        }
      }
      return;
    }

    if (!res.body) throw new Error(`${this.config.id}: empty response body`);

    for await (const data of sseDataEvents(res.body)) {
      if (data === "[DONE]") return; // not in the spec, but harmless
      let event: ResponseEvent;
      try {
        event = JSON.parse(data) as ResponseEvent;
      } catch {
        continue; // partial fragment — skip
      }

      switch (event.type) {
        case "response.output_text.delta":
          if (event.delta) yield { delta: event.delta };
          break;
        case "response.completed":
        case "response.incomplete":
          return;
        case "response.failed":
          throw new Error(
            errorText(event.response?.error) || "response failed",
          );
        case "error":
          throw new Error(errorText(event.error) || event.message || "stream error");
        default:
          break; // reasoning summaries, output_item.* housekeeping — ignore
      }
    }
  }
}

type ResponseOutputPart = { type?: string; text?: string };
type ResponseOutputItem = { type?: string; content?: ResponseOutputPart[] };

type ResponseEvent = {
  type?: string;
  delta?: string;
  message?: string;
  error?: unknown;
  response?: { error?: unknown; status?: string };
  output?: ResponseOutputItem[];
};

type ResponsesEnvelope = {
  error?: unknown;
  output?: ResponseOutputItem[];
};
