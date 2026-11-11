/**
 * Middleware: the layer between user input and the model.
 *
 *   tools/    — functions the model may call (future: tool-use loop)
 *   mcp/      — external tool servers via Model Context Protocol
 *   context/  — shapes the exact message list sent to the model
 *
 * Each area is an interface now; implementations wire in milestone 2.
 */

export { Tool, ToolRegistry } from "./tools/registry";
export { createFileTools, registerFileTools } from "./tools/files";
export { McpServer, McpServerSpec, connectMcp } from "./mcp/client";
export { buildContext, ContextOptions } from "./context/context";
