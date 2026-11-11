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
    this.#push({ role: "assistant", text: "" }); // fills in as chunks arrive
    this.#busy = true;
    this.#emit();

    const started = Date.now();
    const ac = new AbortController();
    this.#abort = ac;
    let reply = "";
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
          reply += event.text;
          this.#updateLastAssistant(reply);
        } else if (event.type === "tool_call") {
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
      if (reply) {
        this.#history.push({ role: "assistant", content: reply });
        if (reasoning) this.#push({ role: "thought", text: "", seconds });
      } else {
        this.#dropLastAssistant(); // nothing arrived — no empty bubble
        if (!ac.signal.aborted) {
          this.#push({ role: "info", text: "(no answer received)" });
        }
      }
      this.#busy = false;
      this.#abort = null;
      this.#notes?.clearTemp(); // temp notes live for exactly one turn
      this.#emit();
    }
  }

  // ---- entry bookkeeping ---------------------------------------------------

  #push(entry: Omit<SessionEntry, "id">): void {
    this.#entries = [...this.#entries, { ...entry, id: this.#nextId++ }];
    this.#emit();
  }

  #updateLastAssistant(text: string): void {
    const idx = this.#entries.map((e) => e.role).lastIndexOf("assistant");
    if (idx === -1) return;
    const next = [...this.#entries];
    next[idx] = { ...next[idx]!, text };
    this.#entries = next;
    this.#emit();
  }

  #dropLastAssistant(): void {
    const idx = this.#entries.map((e) => e.role).lastIndexOf("assistant");
    if (idx === -1) return;
    this.#entries = [
      ...this.#entries.slice(0, idx),
      ...this.#entries.slice(idx + 1),
    ];
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
