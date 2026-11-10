/**
 * MCP — external tool sources via the Model Context Protocol.
 * Interface reserved now; the actual client lands in a later milestone.
 */
import type { Tool } from "../tools/registry";

/** An MCP server halo is connected to. */
export interface McpServer {
  name: string;
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

export interface McpServerSpec {
  name: string;
  command: string;
}

export async function connectMcp(_spec: McpServerSpec): Promise<McpServer> {
  throw new Error("MCP support lands in a later milestone — interface reserved");
}
