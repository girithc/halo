/**
 * Context gathering — the "in" side of a turn.
 *
 * Takes the conversation history plus the new user input and produces
 * the exact message list the model should receive: system prompt
 * prepended, history trimmed, user turn appended. Pure function.
 */
import { buildContext } from "../middleware/context/context";
import type { ChatMessage } from "../../models/types";

export const SYSTEM_PROMPT =
  "You are halo, a concise terminal coding agent. " +
  "Answer in plain text, use fenced code blocks for code, and keep it short. " +
  "You have tools (file_search, file_read, file_create, file_edit, shell_run, " +
  "git_*, note_*): use them to inspect the real project before answering — " +
  "never guess file paths or invent command output.";

export interface GatherOptions {
  systemPrompt?: string;
  /** Keep at most this many non-system messages (oldest dropped). */
  maxMessages?: number;
}

/**
 * Assembles the message list for one LLM call.
 *
 * @param history prior turns WITHOUT the system prompt
 * @param input   the new user message
 */
export function gatherContext(
  history: readonly ChatMessage[],
  input: string,
  options: GatherOptions = {},
): ChatMessage[] {
  const turn: ChatMessage = { role: "user", content: input };
  return buildContext(options.systemPrompt ?? SYSTEM_PROMPT, [...history, turn], {
    maxMessages: options.maxMessages,
  });
}
