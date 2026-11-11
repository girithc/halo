import { describeError, sseDataEvents } from "../http";
import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  ModelConfig,
  ModelProvider,
  ToolCallRequest,
} from "../types";

/**
 * Works with any OpenAI-compatible *Chat Completions* endpoint:
 * DeepSeek, OpenAI, OpenRouter, Groq, local Ollama, ...
 *
 * Streams text deltas as they arrive and accumulates streamed
 * `tool_calls` fragments; complete calls are emitted as a single
 * `tool_calls` chunk once the stream ends.
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
    options: ChatOptions = {},
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
        messages: messages.map(toWireMessage),
        stream: true,
        ...(options.tools?.length ? { tools: options.tools } : {}),
      }),
      signal: options.signal,
    });

    if (!res.ok) {
      throw new Error(`${this.config.id}: ${await describeError(res)}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // Provider ignored `stream: true` — fall back to one whole reply.
      const json = (await res.json()) as CompletionResponse;
      if (json.error) throw new Error(json.error.message ?? "request failed");
      const message = json.choices?.[0]?.message;
      const calls = fromWireToolCalls(message?.tool_calls);
      if (calls.length > 0) yield { kind: "tool_calls", calls };
      if (message?.content) yield { kind: "answer", text: message.content };
      return;
    }

    if (!res.body) throw new Error(`${this.config.id}: empty response body`);

    // Streamed tool_calls arrive as index-keyed fragments that must be
    // stitched together across chunks (id + name on the first, argument
    // JSON split over many deltas).
    const pending = new Map<number, ToolCallRequest>();

    for await (const data of sseDataEvents(res.body)) {
      if (data === "[DONE]") break;
      let json: CompletionResponse;
      try {
        json = JSON.parse(data) as CompletionResponse;
      } catch {
        continue; // partial fragment — skip
      }
      if (json.error) throw new Error(json.error.message ?? "stream error");
      const delta = json.choices?.[0]?.delta;
      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (reasoning) yield { kind: "reasoning", text: reasoning };
      if (delta?.content) yield { kind: "answer", text: delta.content };
      for (const fragment of delta?.tool_calls ?? []) {
        const slot = pending.get(fragment.index) ?? {
          id: "",
          name: "",
          arguments: "",
        };
        if (fragment.id) slot.id = fragment.id;
        if (fragment.function?.name) slot.name += fragment.function.name;
        if (fragment.function?.arguments) {
          slot.arguments += fragment.function.arguments;
        }
        pending.set(fragment.index, slot);
      }
    }

    if (pending.size > 0) {
      const calls = [...pending.keys()].sort((a, b) => a - b).map((i) => pending.get(i)!);
      yield { kind: "tool_calls", calls };
    }
  }
}

/** OpenAI wire shape for a message, including tool roles. */
function toWireMessage(m: ChatMessage): unknown {
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      })),
    };
  }
  if (m.role === "tool") {
    return {
      role: "tool",
      tool_call_id: m.toolCallId,
      name: m.name,
      content: m.content,
    };
  }
  return { role: m.role, content: m.content };
}

function fromWireToolCalls(
  wire: WireToolCall[] | undefined,
): ToolCallRequest[] {
  return (wire ?? []).map((c, i) => ({
    id: c.id ?? `call_${i}`,
    name: c.function?.name ?? "",
    arguments: c.function?.arguments ?? "",
  }));
}

type WireToolCall = {
  id?: string;
  function?: { name?: string; arguments?: string };
};

type CompletionResponse = {
  error?: { message?: string };
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
      reasoning?: string;
      tool_calls?: Array<WireToolCall & { index: number }>;
    };
    message?: {
      content?: string;
      tool_calls?: WireToolCall[];
    };
  }>;
};
