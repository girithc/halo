/**
 * halo — public library surface.
 *
 * The CLI is one consumer of this API; anything else (an editor plugin,
 * a server) can compose the same pieces.
 */
import { DEFAULT_MODEL, ModelRegistry } from "./models/registry";
import type { ModelProvider } from "./models/types";
import { resolveApiKey } from "./secrets/store";

export { DEFAULT_MODEL, MODEL_PRESETS, ModelRegistry } from "./models/registry";
export { MetaProvider } from "./models/providers/meta";
export { parseInput, InputReader, CANCEL } from "./core/in/input";
export * as out from "./core/out/output";
export { resolveApiKey, saveApiKey, maskKey } from "./secrets/store";
export { loadConfig, saveConfig, configPath } from "./secrets/config";
export type {
  ChatMessage,
  ChatChunk,
  ModelConfig,
  ModelProvider,
} from "./models/types";

export interface Agent {
  registry: ModelRegistry;
  provider: ModelProvider;
}

/**
 * Convenience factory: resolves credentials and wires a registry
 * to a provider in one call. Throws if no API key is configured.
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
  return { registry, provider: registry.createProvider(auth.key) };
}
