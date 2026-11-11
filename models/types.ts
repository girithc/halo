/**
 * The contract every model backend signs. Everything downstream
 * (core, interface) depends only on these types — never on a
 * concrete provider, so swapping backends never ripples.
 */

/** A tool invocation the model requested (wire shape). */
export interface ToolCallRequest {
  id: string;
  name: string;
  /** Raw JSON argument string exactly as the model produced it. */
  arguments: string;
}

/** Tool definitions advertised to the model (OpenAI function format). */
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * A single message in the conversation.
 * Plain chat uses system/user/assistant; the tool-calling loop adds
 * assistant messages carrying `toolCalls` and `tool` messages carrying
 * one result each (linked via `toolCallId`).
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** assistant only: tool calls the model requested in this turn. */
  toolCalls?: ToolCallRequest[];
  /** tool only: the call this result answers. */
  toolCallId?: string;
  /** tool only: the invoked tool's name, for readability. */
  name?: string;
}

/**
 * One streamed fragment of the assistant's reply.
 * Reasoning models stream their thinking first (or interleaved):
 * renderers show `reasoning` dimmed and `answer` normally. When the
 * model decides to call tools instead of answering, the provider emits
 * one complete `tool_calls` chunk at the end of the stream.
 */
export type ChatChunk =
  | { kind: "reasoning"; text: string }
  | { kind: "answer"; text: string }
  | { kind: "tool_calls"; calls: ToolCallRequest[] };

/** Per-call options for a provider request. */
export interface ChatOptions {
  signal?: AbortSignal;
  /** Tools the model may call; providers advertise them on the wire. */
  tools?: ToolSpec[];
}

export interface ModelConfig {
  /** Preset name, e.g. "deepseek" — kept so /config can round-trip it. */
  name?: string;
  /** Model id exactly as the provider API expects it, e.g. "deepseek-chat". */
  id: string;
  /** Base URL, e.g. "https://api.deepseek.com/v1". */
  baseURL: string;
  /**
   * Wire protocol the endpoint speaks:
   *  - "chat-completions" (default): POST {base}/chat/completions with `messages`
   *  - "responses": POST {base}/responses with `input`, typed SSE events (Meta)
   */
  api?: "chat-completions" | "responses";
  /** Env var names that hold this provider's key, checked first. */
  apiKeyEnv?: string[];
  /** Reasoning effort for thinking models (Responses API only). */
  reasoningEffort?: "low" | "medium" | "high";
}

/** Any chat backend that can stream a reply. */
export interface ModelProvider {
  readonly config: ModelConfig;
  chat(
    messages: readonly ChatMessage[],
    options?: ChatOptions,
  ): AsyncIterable<ChatChunk>;
}
