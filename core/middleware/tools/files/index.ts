/** File tools bundle: search, read, create, edit — all rooted at `root`. */
import { ToolRegistry } from "../registry";
import { createTool } from "./create";
import { editTool } from "./edit";
import { readTool } from "./read";
import { searchTool } from "./search";

export { searchTool } from "./search";
export { readTool } from "./read";
export { createTool } from "./create";
export { editTool } from "./edit";

/** The four file tools, unregistered. */
export function createFileTools(root: string = process.cwd()) {
  return [searchTool(root), readTool(root), createTool(root), editTool(root)];
}

/** Registers all file tools into a registry (or a fresh one) and returns it. */
export function registerFileTools(
  registry: ToolRegistry = new ToolRegistry(),
  root: string = process.cwd(),
): ToolRegistry {
  for (const tool of createFileTools(root)) registry.register(tool);
  return registry;
}
