/** Notes CRUD tools — backed by a shared NoteStore. */
import type { Tool } from "../registry";
import type { NoteScope, NoteStore } from "./store";

const SCOPES: NoteScope[] = ["temp", "session"];

function scopeOf(args: Record<string, unknown>): NoteScope {
  return args.scope === "temp" ? "temp" : "session";
}

export function createNoteTools(store: NoteStore): Tool[] {
  return [
    {
      name: "note_add",
      description:
        "Write a note for yourself. scope 'temp' lives only until this turn's reply " +
        "completes (scratch work); 'session' lasts the whole session (default).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "short title" },
          text: { type: "string", description: "note content" },
          scope: { type: "string", enum: SCOPES, description: "temp or session (default session)" },
        },
        required: ["title", "text"],
      },
      async execute(args) {
        const title = String(args.title ?? "").trim();
        const text = String(args.text ?? "");
        if (!title) return "error: title is required";
        const note = store.add(scopeOf(args), title, text);
        return `note #${note.id} saved (${note.scope}): ${note.title}`;
      },
    },
    {
      name: "note_list",
      description: "List your notes, optionally filtered by scope.",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: SCOPES, description: "filter by scope" },
        },
      },
      async execute(args) {
        const notes = store.list(
          args.scope === "temp" || args.scope === "session" ? (args.scope as NoteScope) : undefined,
        );
        if (notes.length === 0) return "no notes";
        return notes
          .map(
            (n) =>
              `#${n.id} [${n.scope}] ${n.title}${n.text ? ` — ${n.text.slice(0, 80)}` : ""}`,
          )
          .join("\n");
      },
    },
    {
      name: "note_get",
      description: "Read one note in full by id.",
      parameters: {
        type: "object",
        properties: { id: { type: "number", description: "note id" } },
        required: ["id"],
      },
      async execute(args) {
        const note = store.get(Number(args.id));
        return note
          ? `#${note.id} [${note.scope}] ${note.title}\n${note.text}`
          : `error: no note #${Number(args.id)}`;
      },
    },
    {
      name: "note_update",
      description: "Update a note's title and/or text.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "number", description: "note id" },
          title: { type: "string", description: "new title" },
          text: { type: "string", description: "new text" },
        },
        required: ["id"],
      },
      async execute(args) {
        const updated = store.update(Number(args.id), {
          title: args.title === undefined ? undefined : String(args.title),
          text: args.text === undefined ? undefined : String(args.text),
        });
        return updated
          ? `note #${updated.id} updated`
          : `error: no note #${Number(args.id)}`;
      },
    },
    {
      name: "note_delete",
      description: "Delete a note by id.",
      parameters: {
        type: "object",
        properties: { id: { type: "number", description: "note id" } },
        required: ["id"],
      },
      async execute(args) {
        const id = Number(args.id);
        return store.remove(id) ? `note #${id} deleted` : `error: no note #${id}`;
      },
    },
  ];
}
