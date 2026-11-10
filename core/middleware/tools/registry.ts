/**
 * Tools — functions the model may call. The tool-use loop in the CLI
 * will advertise these to the model and execute its choices.
 */

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
}
