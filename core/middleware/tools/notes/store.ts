/**
 * Notes — the agent's scratch memory.
 *
 * Two scopes:
 *   "temp"     — lives for a single turn; cleared when the reply completes
 *                (intermediate findings during a multi-step task)
 *   "session"  — lives for the whole session; survives across turns
 *                (decisions, file paths discovered, todos)
 */
export type NoteScope = "temp" | "session";

export interface Note {
  id: number;
  scope: NoteScope;
  title: string;
  text: string;
  createdAt: number;
}

export class NoteStore {
  #notes = new Map<number, Note>();
  #nextId = 1;

  add(scope: NoteScope, title: string, text: string): Note {
    const note: Note = {
      id: this.#nextId++,
      scope,
      title,
      text,
      createdAt: Date.now(),
    };
    this.#notes.set(note.id, note);
    return note;
  }

  list(scope?: NoteScope): Note[] {
    const all = [...this.#notes.values()];
    return scope ? all.filter((n) => n.scope === scope) : all;
  }

  get(id: number): Note | undefined {
    return this.#notes.get(id);
  }

  update(id: number, patch: { title?: string; text?: string }): Note | undefined {
    const note = this.#notes.get(id);
    if (!note) return undefined;
    const updated: Note = {
      ...note,
      title: patch.title ?? note.title,
      text: patch.text ?? note.text,
    };
    this.#notes.set(id, updated);
    return updated;
  }

  remove(id: number): boolean {
    return this.#notes.delete(id);
  }

  /** Drop temp notes — called when a turn's reply completes. */
  clearTemp(): number {
    let removed = 0;
    for (const note of this.#notes.values()) {
      if (note.scope === "temp") {
        this.#notes.delete(note.id);
        removed++;
      }
    }
    return removed;
  }
}
