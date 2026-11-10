/**
 * The contract every model backend signs. Everything downstream
 * (core, interface) depends only on these types — never on a
 * concrete provider, so swapping backends never ripples.
 */

/** A single message in the conversation. */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** One streamed fragment of the assistant's reply. */
export interface ChatChunk {
  delta: string;
}

export interface ModelConfig {
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
}

/** Any chat backend that can stream a reply. */
export interface ModelProvider {
  readonly config: ModelConfig;
  chat(
    messages: readonly ChatMessage[],
    signal: AbortSignal,
  ): AsyncIterable<ChatChunk>;
}
