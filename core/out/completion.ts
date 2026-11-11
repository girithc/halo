/**
 * Completion — the "out" side of a turn.
 *
 * Calls the model with the gathered context, streams its response as
 * events, and runs the tool-calling loop: when the model asks for a
 * tool, execute it via the registry, hand the result back, and let the
 * model continue until it produces a final answer.
 */
import type {
  ChatMessage,
  ChatOptions,
  ModelProvider,
  ToolCallRequest,
} from "../../models/types";
import type { ToolRegistry } from "../middleware/tools/registry";

/** Everything that happens while producing one model response. */
export type TurnEvent =
  | { type: "reasoning"; text: string }
  | { type: "answer"; text: string }
  | { type: "tool_call"; call: ToolCallRequest }
  | { type: "tool_result"; call: ToolCallRequest; result: string };

export interface TurnOptions {
  provider: ModelProvider;
  /** Full gathered context: system prompt + history + new user turn. */
  messages: readonly ChatMessage[];
  /** Tools the model may call. Omit (or leave empty) for plain chat. */
  tools?: ToolRegistry;
  signal?: AbortSignal;
  /** Safety valve against runaway tool loops. Default 8. */
  maxToolRounds?: number;
}

/**
 * Run one assistant turn to completion. Yields streaming events;
 * returns when the model produces an answer without tool calls (or
 * after `maxToolRounds` tool rounds).
 */
export async function* runTurn(
  options: TurnOptions,
): AsyncGenerator<TurnEvent, void> {
  const { provider, tools, signal } = options;
  const maxRounds = options.maxToolRounds ?? 10;
  const convo: ChatMessage[] = [...options.messages];

  for (let round = 0; round < maxRounds; round++) {
    let reply = "";
    let calls: ToolCallRequest[] | undefined;

    const chatOptions: ChatOptions = { signal };
    if (tools && tools.list().length > 0) chatOptions.tools = tools.specs();

    for await (const chunk of provider.chat(convo, chatOptions)) {
      if (chunk.kind === "reasoning") {
        yield { type: "reasoning", text: chunk.text };
      } else if (chunk.kind === "answer") {
        reply += chunk.text;
        yield { type: "answer", text: chunk.text };
      } else {
        calls = chunk.calls;
      }
    }

    // No tool calls — the streamed answer IS the final response.
    if (!calls || calls.length === 0) return;

    convo.push({ role: "assistant", content: reply, toolCalls: calls });
    for (const call of calls) {
      yield { type: "tool_call", call };
      const result = await executeTool(tools, call);
      convo.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: result,
      });
      yield { type: "tool_result", call, result };
    }
    // Loop: the model now sees the tool results and continues.
  }

  // Tool budget exhausted — force closure instead of dying silently:
  // one final call with NO tools advertised, so the model must answer
  // from whatever it gathered.
  convo.push({
    role: "user",
    content:
      "Tool budget reached. Answer the user's original request NOW from " +
      "what you have gathered so far — do not attempt more tool calls.",
  });
  for await (const chunk of provider.chat(convo, { signal })) {
    if (chunk.kind === "reasoning") {
      yield { type: "reasoning", text: chunk.text };
    } else if (chunk.kind === "answer") {
      yield { type: "answer", text: chunk.text };
    } else if (chunk.kind === "tool_calls") {
      yield {
        type: "answer",
        text: "\n(tool budget reached — no further tool calls possible)",
      };
    }
  }
}

/** Execute one tool call, converting every failure into a model-readable error. */
async function executeTool(
  tools: ToolRegistry | undefined,
  call: ToolCallRequest,
): Promise<string> {
  const tool = tools?.get(call.name);
  if (!tool) return `error: unknown tool "${call.name}"`;
  let args: Record<string, unknown> = {};
  if (call.arguments) {
    try {
      args = JSON.parse(call.arguments) as Record<string, unknown>;
    } catch {
      return "error: tool arguments were not valid JSON";
    }
  }
  try {
    return await tool.execute(args);
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
