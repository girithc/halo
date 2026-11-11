/**
 * halo — public library surface.
 *
 * The CLI is one consumer of this API; anything else (an editor plugin,
 * a server) can compose the same pieces.
 *
 * Architecture:
 *   core/in    — user input parsing + context gathering
 *   core/out   — chat completion: the LLM call, streaming, tool calling
 *   core/agent — AgentSession: the headless conductor wiring in → out
 *   models/    — wire-protocol providers the completion loop drives
 *   interface/ — pure UI (render + keystrokes only)
 */
import { AgentSession } from "./core/agent";
import { SYSTEM_PROMPT } from "./core/in/context";
import { DEFAULT_MODEL, ModelRegistry } from "./models/registry";
import type { ModelProvider } from "./models/types";
import { resolveApiKey } from "./secrets/store";

export { AgentSession } from "./core/agent";
export type { SessionEntry, SessionState } from "./core/agent";
export { runTurn } from "./core/out/completion";
export type { TurnEvent, TurnOptions } from "./core/out/completion";
export { gatherContext, SYSTEM_PROMPT } from "./core/in/context";
export { parseInput, InputReader, CANCEL } from "./core/in/input";
export { ToolRegistry } from "./core/middleware/tools/registry";
export type { Tool } from "./core/middleware/tools/registry";
export { DEFAULT_MODEL, MODEL_PRESETS, ModelRegistry } from "./models/registry";
export { MetaProvider } from "./models/providers/meta";
export { resolveApiKey, saveApiKey, maskKey } from "./secrets/store";
export { loadConfig, saveConfig, configPath } from "./secrets/config";
export type {
  ChatMessage,
  ChatChunk,
  ChatOptions,
  ModelConfig,
  ModelProvider,
  ToolCallRequest,
  ToolSpec,
} from "./models/types";

export interface Agent {
  registry: ModelRegistry;
  provider: ModelProvider;
  session: AgentSession;
}

/**
 * Convenience factory: resolves credentials and wires a registry to a
 * provider and a headless session in one call. Throws if no API key is
 * configured.
 */
export async function createAgent(
  options: { model?: string; baseURL?: string } = {},
): Promise<Agent> {
  const auth = await resolveApiKey();
  if (!auth) {
    throw new Error("No API key found. Run `halo` once to set one up.");
  }
  const registry = new ModelRegistry({
    id: options.model ?? DEFAULT_MODEL.id,
    baseURL: options.baseURL ?? DEFAULT_MODEL.baseURL,
  });
  const provider = registry.createProvider(auth.key);
  const session = new AgentSession({
    registry,
    getApiKey: () => Promise.resolve(auth!.key),
    systemPrompt: SYSTEM_PROMPT,
  });
  return { registry, provider, session };
}
