#!/usr/bin/env bun
/**
 * halo — terminal coding agent.
 *
 *   halo              interactive session (first run: setup wizard)
 *   halo "prompt"     one-shot answer
 */
import { CANCEL, InputReader, parseInput } from "../../core/in/input";
import * as out from "../../core/out/output";
import {
  DEFAULT_MODEL,
  MODEL_PRESETS,
  ModelRegistry,
  needsApiKey,
} from "../../models/registry";
import type { ChatMessage, ModelConfig } from "../../models/types";
import { configPath, loadConfig, saveConfig } from "../../secrets/config";
import { resolveApiKey, type ApiKey } from "../../secrets/store";
import { runOnboarding } from "./onboard";

const VERSION = "0.1.0";
const SYSTEM_PROMPT =
  "You are halo, a concise terminal coding agent. " +
  "Answer in plain text, use fenced code blocks for code, and keep it short.";

function parseApi(value: string | undefined): ModelConfig["api"] {
  return value === "responses" || value === "chat-completions"
    ? value
    : undefined;
}

async function main(): Promise<void> {
  const flags = process.argv.slice(2);
  if (flags.some((a) => a === "-h" || a === "--help")) {
    out.printHelp(Object.keys(MODEL_PRESETS));
    return;
  }
  if (flags.some((a) => a === "-v" || a === "--version")) {
    console.log(`halo ${VERSION}`);
    return;
  }

  // Resolve the starting model: env > ~/.halo/config.json > default preset.
  const stored = await loadConfig();
  const fallback = (stored.provider ? MODEL_PRESETS[stored.provider] : undefined) ?? DEFAULT_MODEL;
  const base: ModelConfig = {
    ...fallback,
    name: stored.provider ?? fallback.name,
    id: process.env.HALO_MODEL ?? stored.model ?? fallback.id,
    baseURL: process.env.HALO_BASE_URL ?? stored.baseURL ?? fallback.baseURL,
    api: parseApi(process.env.HALO_API) ?? stored.api ?? fallback.api,
    apiKeyEnv: stored.apiKeyEnv ?? fallback.apiKeyEnv,
  };
  const registry = new ModelRegistry(base);

  let currentRequest: AbortController | null = null;
  const reader = new InputReader(() => {
    // Ctrl-C with nothing pending: abort the running request, else quit.
    if (currentRequest) {
      currentRequest.abort();
      return;
    }
    process.exit(0);
  });

  // Credentials: stored keys first; otherwise the first-run wizard (TTY only).
  let auth: ApiKey | null = await resolveApiKey(base.apiKeyEnv);
  if (!auth && needsApiKey(base)) {
    if (process.stdin.isTTY !== true) {
      throw new Error(
        `no API key found — set ${(base.apiKeyEnv ?? ["HALO_API_KEY"]).join(" or ")}` +
          " (or run `halo` in a terminal to set one up)",
      );
    }
    const result = await runOnboarding(reader);
    registry.setConfig(result.config);
    auth = {
      key: result.apiKey ?? "local",
      source: result.apiKey ? "~/.halo/.env" : "",
    };
  }
  if (!auth) auth = { key: "local", source: "" }; // local provider, no key
  const apiKey = auth.key;

  out.banner(
    registry.active(),
    needsApiKey(registry.active())
      ? auth.source
        ? `key from ${auth.source}`
        : null
      : "local model — no API key needed",
  );

  const history: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];

  async function send(text: string): Promise<void> {
    history.push({ role: "user", content: text });
    const view = out.createStreamView(`thinking · ${registry.active().id}`);
    const ac = new AbortController();
    currentRequest = ac;
    let reply = "";
    try {
      // Re-resolve per request so /model switches pick the right key.
      const requestAuth =
        (await resolveApiKey(registry.active().apiKeyEnv)) ?? auth!;
      for await (const chunk of registry
        .createProvider(requestAuth.key)
        .chat(history, ac.signal)) {
        reply += chunk.delta;
        view.delta(chunk.delta);
      }
    } catch (err) {
      if (ac.signal.aborted) {
        out.info("· cancelled");
      } else {
        out.error(err instanceof Error ? err.message : String(err));
      }
    } finally {
      view.end();
      currentRequest = null;
    }
    if (reply) {
      history.push({ role: "assistant", content: reply });
    } else if (!ac.signal.aborted) {
      out.info("(empty response)");
    }
  }

  async function handleCommand(name: string, args: string): Promise<void> {
    switch (name) {
      case "help":
        out.printHelp(Object.keys(MODEL_PRESETS));
        return;
      case "model": {
        if (!args) {
          out.info(
            `active model: ${registry.active().id} @ ${registry.active().baseURL}`,
          );
          return;
        }
        const preset = MODEL_PRESETS[args.toLowerCase()];
        if (preset) {
          registry.setConfig(preset);
          out.success(`${preset.id} @ ${preset.baseURL} (session only)`);
          return;
        }
        registry.setModelId(args);
        out.success(`model set to ${args} (session only — /config persists)`);
        return;
      }
      case "config": {
        const active = registry.active();
        const path = await saveConfig({
          provider: active.name,
          model: active.id,
          baseURL: active.baseURL,
          api: active.api,
          apiKeyEnv: active.apiKeyEnv,
        });
        out.success(`saved ${active.id} → ${path}`);
        return;
      }
      case "clear":
        history.splice(1); // keep the system prompt
        out.info("conversation history cleared");
        return;
      default:
        out.error(`unknown command /${name} — try /help`);
    }
  }

  const oneShot = flags.filter((a) => !a.startsWith("-"));
  if (oneShot.length > 0) {
    await send(oneShot.join(" "));
    reader.close();
    return;
  }

  for (;;) {
    const line = await reader.readLine();
    if (line === CANCEL || reader.isClosed()) break;
    const parsed = parseInput(line);
    if (parsed.kind === "command") {
      if (parsed.name === "quit" || parsed.name === "exit" || parsed.name === "q") break;
      await handleCommand(parsed.name, parsed.args);
      continue;
    }
    if (!parsed.text) continue;
    await send(parsed.text);
  }

  reader.close();
  out.info("bye 👋");
}

main().catch((err: unknown) => {
  out.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
