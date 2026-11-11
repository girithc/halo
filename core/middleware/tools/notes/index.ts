export { NoteStore, type Note, type NoteScope } from "./store";
export { createNoteTools } from "./notes";

import type { ToolRegistry } from "../registry";
import { NoteStore } from "./store";
import { createNoteTools } from "./notes";

export function registerNoteTools(
  registry: ToolRegistry,
  store: NoteStore = new NoteStore(),
): ToolRegistry {
  for (const tool of createNoteTools(store)) registry.register(tool);
  return registry;
}
