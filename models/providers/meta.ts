import { describeError, errorText, sseDataEvents } from "../http";
import type {
  ChatChunk,
  ChatMessage,
  ChatOptions,
  ModelConfig,
  ModelProvider,
  ToolCallRequest,
} from "../types";

/**
 * Meta's api.meta.ai speaks the OpenAI **Responses** wire protocol:
 * POST {base}/responses with `input`, streamed as typed SSE events
 * (`response.output_text.delta`, `response.output_item.*`, ...).
 *
 * Tool calling in this protocol: tools are advertised flat
 * (`{ type: "function", name, ... }`), a model tool call arrives as a
 * `function_call` output item (arguments streamed as deltas), and a
 * tool result goes back as a `function_call_output` input item.
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
    options: ChatOptions = {},
  ): AsyncIterable<ChatChunk> {
    const url = `${this.config.baseURL.replace(/\/+$/, "")}/responses`;
    const toolSpecs = options.tools?.map((t) => ({
      type: "function",
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.id,
        input: toResponsesInput(messages),
        stream: true,
        // Without this the server defaults to effort "high" and thinks
        // for a very long time before the first token.
        ...(this.config.reasoningEffort
          ? { reasoning: { effort: this.config.reasoningEffort } }
          : {}),
        ...(toolSpecs ? { tools: toolSpecs, tool_choice: "auto" } : {}),
      }),
      signal: options.signal,
    });

    if (!res.ok) {
      throw new Error(`${this.config.id}: ${await describeError(res)}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      // Provider ignored `stream: true` — parse a whole Responses payload.
      const json = (await res.json()) as ResponsesEnvelope;
      if (json.error) throw new Error(errorText(json.error) || "request failed");
      const calls: ToolCallRequest[] = [];
      for (const item of json.output ?? []) {
        if (item.type === "function_call" && item.name) {
          calls.push({
            id: item.call_id ?? item.id ?? `call_${calls.length}`,
            name: item.name,
            arguments: item.arguments ?? "",
          });
        } else if (item.type === "message") {
          for (const part of item.content ?? []) {
            if (part.type === "output_text" && part.text) {
              yield { kind: "answer", text: part.text };
            }
          }
        }
      }
      if (calls.length > 0) yield { kind: "tool_calls", calls };
      return;
    }

    if (!res.body) throw new Error(`${this.config.id}: empty response body`);

    // Tool calls accumulate as function_call items; their argument JSON
    // may stream in through function_call_arguments.delta events.
    const calls = new Map<string, ToolCallRequest>();
    const order: string[] = [];

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
          if (event.delta) yield { kind: "answer", text: event.delta };
          break;
        case "response.reasoning_summary_text.delta": // summarized thinking
        case "response.reasoning_text.delta": // raw thinking channel
          if (event.delta) yield { kind: "reasoning", text: event.delta };
          break;
        case "response.output_item.added":
        case "response.output_item.done": {
          const item = event.item;
          if (item?.type !== "function_call") break;
          const key = item.id ?? item.call_id ?? `call_${order.length}`;
          const existing = calls.get(key);
          if (!existing) order.push(key);
          // On done the item carries the full arguments; while streaming
          // we keep what we've accumulated from argument deltas.
          const useItemArgs =
            event.type === "response.output_item.done" &&
            (item.arguments ?? "") !== "";
          calls.set(key, {
            id: item.call_id ?? item.id ?? key,
            name: item.name ?? existing?.name ?? "",
            arguments: useItemArgs
              ? item.arguments!
              : (existing?.arguments ?? item.arguments ?? ""),
          });
          break;
        }
        case "response.function_call_arguments.delta": {
          const key = order[order.length - 1];
          if (key && event.delta) {
            const existing = calls.get(key);
            if (existing) {
              calls.set(key, {
                ...existing,
                arguments: existing.arguments + event.delta,
              });
            }
          }
          break;
        }
        case "response.completed":
        case "response.incomplete": {
          const final = order
            .map((k) => calls.get(k)!)
            .filter((c) => c?.name);
          if (final.length > 0) yield { kind: "tool_calls", calls: final };
          return;
        }
        case "response.failed":
          throw new Error(
            errorText(event.response?.error) || "response failed",
          );
        case "error":
          throw new Error(errorText(event.error) || event.message || "stream error");
        default:
          break; // content_part.* housekeeping — ignore
      }
    }
  }
}

type ResponseOutputPart = { type?: string; text?: string };

type ResponseOutputItem = {
  type?: string; // "message" | "function_call" | "reasoning" | ...
  content?: ResponseOutputPart[];
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
};

type ResponseEvent = {
  type?: string;
  delta?: string;
  message?: string;
  error?: unknown;
  item?: ResponseOutputItem;
  response?: { error?: unknown; status?: string };
  output?: ResponseOutputItem[];
};

type ResponsesEnvelope = {
  error?: unknown;
  output?: ResponseOutputItem[];
};

/** Halo history -> Responses `input` items (including tool turns). */
function toResponsesInput(messages: readonly ChatMessage[]): unknown[] {
  const items: unknown[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      items.push({
        type: "function_call_output",
        call_id: m.toolCallId,
        output: m.content,
      });
    } else if (m.role === "assistant" && m.toolCalls?.length) {
      if (m.content) items.push({ role: "assistant", content: m.content });
      for (const call of m.toolCalls) {
        items.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
    } else {
      items.push({ role: m.role, content: m.content });
    }
  }
  return items;
}
