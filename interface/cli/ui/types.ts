/** Data model of the halo chat UI — the shapes the whole UI reads. */
import type { ModelRegistry } from "../../../models/registry";

/** One entry in the chat data. The UI is a pure function of this. */
export interface ChatEntry {
  id: number;
  role: "user" | "assistant" | "info" | "thought";
  text: string;
  seconds?: number;
}

export interface AppProps {
  registry: ModelRegistry;
  apiKey: string;
  /** Keyboard capture; auto-false is used by headless smoke tests. */
  interactive?: boolean;
  /** Sent automatically on mount (used by the UI smoke test). */
  initialPrompt?: string;
}

/** One renderable row (prefix + styled text). */
export interface Line {
  prefix?: string;
  prefixColor?: string;
  text: string;
  color?: string;
  dim?: boolean;
  italic?: boolean;
}
