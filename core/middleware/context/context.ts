/**
 * Context — shapes the exact message list sent to the model.
 * Pure function today; the CLI's history + future memory will flow
 * through here.
 */
import type { ChatMessage } from "../../../models/types";

export interface ContextOptions {
  /** Keep at most this many non-system messages (oldest dropped). */
  maxMessages?: number;
}

/** Builds the message array a provider should receive. */
export function buildContext(
  systemPrompt: string,
  history: readonly ChatMessage[],
  options: ContextOptions = {},
): ChatMessage[] {
  const trimmed = options.maxMessages
    ? history.slice(-options.maxMessages)
    : [...history];
  return [{ role: "system", content: systemPrompt }, ...trimmed];
}
