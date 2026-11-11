export { gitTools } from "./git";

import type { ToolRegistry } from "../registry";
import { gitTools } from "./git";

export function registerGitTools(registry: ToolRegistry, root: string = process.cwd()): ToolRegistry {
  for (const tool of gitTools(root)) registry.register(tool);
  return registry;
}
