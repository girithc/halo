/**
 * Tools — functions the model may call. The completion loop in core/out
 * advertises these to the model and executes its choices.
 */
import type { ToolSpec } from "../../../models/types";

export interface Tool {
  name: string;
  description: string;
  /** JSON-schema-ish parameter spec advertised to the model. */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string>;
}

export class ToolRegistry {
  #tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.#tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  list(): Tool[] {
    return [...this.#tools.values()];
  }

  /** Wire-format tool definitions to advertise to the model. */
  specs(): ToolSpec[] {
    return this.list().map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
}
