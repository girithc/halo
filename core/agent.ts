/**
 * AgentSession — the headless conductor that wires core/in to core/out.
 *
 * A turn is: gather context (in) → run the completion + tool loop (out)
 * → record the exchange. The session owns the chat data (entries +
 * history) and notifies subscribers on every change; frontends are pure
 * renderers of that data. The CLI is one consumer — a server or editor
 * plugin can drive the same session.
 */
import { gatherContext } from "./in/context";
import { runTurn } from "./out/completion";
import type { ToolRegistry } from "./middleware/tools/registry";
import type { NoteStore } from "./middleware/tools/notes/store";
import type { ChatMessage } from "../models/types";
import type { ModelRegistry } from "../models/registry";

/** One entry in the chat data. The UI is a pure function of it. */
export interface SessionEntry {
  id: number;
  role: "user" | "assistant" | "info" | "thought";
  text: string;
  seconds?: number;
}

/** Immutable snapshot handed to subscribers (React-friendly identity). */
export interface SessionState {
  entries: readonly SessionEntry[];
  busy: boolean;
}

export interface AgentSessionOptions {
  registry: ModelRegistry;
  /** Resolves the credential for each turn (env, store, session key...). */
  getApiKey: () => Promise<string>;
  /** Tools advertised to the model; omit for plain chat. */
  tools?: ToolRegistry;
  /** Agent notes; "temp" notes are cleared when each turn completes. */
  notes?: NoteStore;
  systemPrompt?: string;
}

export class AgentSession {
  #registry: ModelRegistry;
  #getApiKey: () => Promise<string>;
  #tools?: ToolRegistry;
  #notes?: NoteStore;
  #systemPrompt: string;
  #history: ChatMessage[] = [];
  #entries: SessionEntry[] = [];
  #busy = false;
  #abort: AbortController | null = null;
  #subscribers = new Set<() => void>();
  #snapshot: SessionState = { entries: [], busy: false };
  #nextId = 1;

  constructor(options: AgentSessionOptions) {
    this.#registry = options.registry;
    this.#getApiKey = options.getApiKey;
    this.#tools = options.tools;
    this.#notes = options.notes;
    this.#systemPrompt = options.systemPrompt ?? "";
  }

  /** Cached view state; identity changes only when something changed. */
  get state(): SessionState {
    return this.#snapshot;
  }

  get busy(): boolean {
    return this.#busy;
  }

  get modelId(): string {
    return this.#registry.active().id;
  }

  /** Model id is registry state, not chat state — read live. */
  activeModel() {
    return this.#registry.active();
  }

  subscribe(fn: () => void): () => void {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  /** Interrupt the running turn. */
  abort(): void {
    this.#abort?.abort();
  }

  /** Push a frontend-visible informational entry (errors, notices). */
  info(text: string): void {
    this.#push({ role: "info", text });
  }

  /** Reset conversation history and the chat view. */
  clear(): void {
    this.#history = [];
    this.#entries = [];
    this.#emit();
  }

  /** Run one full turn for a user message. Resolves when idle again. */
  async send(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.#busy) return;

    // Gather the exact message list (core/in) before recording the turn.
    const messages = gatherContext(this.#history, trimmed, {
      systemPrompt: this.#systemPrompt,
    });
    this.#history.push({ role: "user", content: trimmed });
    this.#push({ role: "user", text: trimmed });
    this.#busy = true;
    this.#emit();

    const started = Date.now();
    const ac = new AbortController();
    this.#abort = ac;
    let roundText = "";
    const rounds: string[] = [];
    let currentAssistantId: number | null = null;
    let reasoning = false;
    try {
      const provider = this.#registry.createProvider(await this.#getApiKey());
      for await (const event of runTurn({
        provider,
        messages,
        tools: this.#tools,
        signal: ac.signal,
      })) {
        if (event.type === "reasoning") {
          reasoning = true;
        } else if (event.type === "answer") {
          // Each tool round streams into its own assistant bubble.
          if (currentAssistantId == null) {
            currentAssistantId = this.#push({ role: "assistant", text: "" });
          }
          roundText += event.text;
          this.#updateEntry(currentAssistantId, roundText);
        } else if (event.type === "tool_call") {
          // A tool round ends here: close the bubble, log the call.
          if (roundText) rounds.push(roundText);
          roundText = "";
          currentAssistantId = null;
          this.#push({
            role: "info",
            text: `⚙ ${event.call.name}(${event.call.arguments})`,
          });
        } else if (event.type === "tool_result") {
          this.#push({
            role: "info",
            text: `↳ ${truncate(event.result, 200)}`,
          });
        }
      }
    } catch (err) {
      const msg = ac.signal.aborted
        ? "cancelled"
        : err instanceof Error
          ? err.message
          : String(err);
      this.#push({ role: "info", text: msg });
    } finally {
      const seconds = Math.max(
        1,
        Math.round((Date.now() - started) / 1000),
      );
      if (roundText) rounds.push(roundText);
      const reply = rounds.filter((t) => t.trim()).join("\n\n");
      if (reply) {
        this.#history.push({ role: "assistant", content: reply });
        if (reasoning) this.#push({ role: "thought", text: "", seconds });
      } else if (!ac.signal.aborted) {
        this.#push({ role: "info", text: "(no answer received)" });
      }
      this.#busy = false;
      this.#abort = null;
      this.#notes?.clearTemp(); // temp notes live for exactly one turn
      this.#emit();
    }
  }

  // ---- entry bookkeeping ---------------------------------------------------

  #push(entry: Omit<SessionEntry, "id">): number {
    const id = this.#nextId++;
    this.#entries = [...this.#entries, { ...entry, id }];
    this.#emit();
    return id;
  }

  #updateEntry(id: number, text: string): void {
    const idx = this.#entries.findIndex((e) => e.id === id);
    if (idx === -1) return;
    const next = [...this.#entries];
    next[idx] = { ...next[idx]!, text };
    this.#entries = next;
    this.#emit();
  }

  #emit(): void {
    this.#snapshot = { entries: this.#entries, busy: this.#busy };
    for (const fn of this.#subscribers) fn();
  }
}

function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
