export { shellTool } from "./shell";

import type { ToolRegistry } from "../registry";
import { shellTool } from "./shell";

export function registerShellTool(registry: ToolRegistry, root: string = process.cwd()): ToolRegistry {
  registry.register(shellTool(root));
  return registry;
}
