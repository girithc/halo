#!/usr/bin/env bun
/**
 * halo — terminal coding agent.
 *
 *   halo              full TUI session (first run: setup wizard)
 *   halo "prompt"     one-shot plain answer
 */
import { render } from "ink";
import { createElement } from "react";
import { InputReader } from "../../core/in/input";
import * as out from "../../core/out/output";
import {
  DEFAULT_MODEL,
  MODEL_PRESETS,
  ModelRegistry,
  needsApiKey,
} from "../../models/registry";
import type { ChatMessage, ModelConfig } from "../../models/types";
import { loadConfig } from "../../secrets/config";
import { resolveApiKey, type ApiKey } from "../../secrets/store";
import { App, SYSTEM_PROMPT } from "./ui/App";

const VERSION = "0.1.0";

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
  const fallback =
    (stored.provider ? MODEL_PRESETS[stored.provider] : undefined) ?? DEFAULT_MODEL;
  const base: ModelConfig = {
    ...fallback,
    name: stored.provider ?? fallback.name,
    id: process.env.HALO_MODEL ?? stored.model ?? fallback.id,
    baseURL: process.env.HALO_BASE_URL ?? stored.baseURL ?? fallback.baseURL,
    api: parseApi(process.env.HALO_API) ?? stored.api ?? fallback.api,
    apiKeyEnv: stored.apiKeyEnv ?? fallback.apiKeyEnv,
    reasoningEffort: stored.reasoningEffort ?? fallback.reasoningEffort,
  };
  const registry = new ModelRegistry(base);

  // Credentials: stored keys first; otherwise the first-run wizard (TTY only).
  let auth: ApiKey | null = await resolveApiKey(base.apiKeyEnv);
  if (!auth && needsApiKey(base)) {
    if (process.stdin.isTTY !== true) {
      throw new Error(
        `no API key found — set ${(base.apiKeyEnv ?? ["HALO_API_KEY"]).join(" or ")}` +
          " (or run `halo` in a terminal to set one up)",
      );
    }
    // The readline reader must live ONLY while the wizard runs — leaving it
    // open would compete with Ink for stdin keystrokes.
    const reader = new InputReader(() => process.exit(0));
    const { runOnboarding } = await import("./onboard");
    const result = await runOnboarding(reader);
    reader.close();
    registry.setConfig(result.config);
    auth = {
      key: result.apiKey ?? "local",
      source: result.apiKey ? "~/.halo/.env" : "",
    };
  }
  if (!auth) auth = { key: "local", source: "" }; // local provider, no key
  const apiKey = auth.key;

  const oneShot = flags.filter((a) => !a.startsWith("-"));

  if (oneShot.length > 0) {
    // Plain non-interactive mode: one request, streamed to stdout.
    await plainSend(registry, apiKey, oneShot.join(" "));
    return;
  }

  if (process.stdin.isTTY !== true) {
    throw new Error('interactive mode needs a terminal — use: halo "prompt"');
  }

  // Take over the whole terminal (alternate screen), restore on exit.
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  try {
    const { waitUntilExit } = render(
      createElement(App, { registry, apiKey }),
      { exitOnCtrlC: false },
    );
    await waitUntilExit();
  } finally {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  }
  out.info("bye 👋");
}

/** One-shot streaming to stdout, no TUI. */
async function plainSend(
  registry: ModelRegistry,
  apiKey: string,
  text: string,
): Promise<void> {
  const history: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  history.push({ role: "user", content: text });
  const view = out.createStreamView(`waiting · ${registry.active().id}`);
  const ac = new AbortController();
  let reply = "";
  try {
    const requestAuth =
      (await resolveApiKey(registry.active().apiKeyEnv)) ?? { key: apiKey, source: "" };
    for await (const chunk of registry
      .createProvider(requestAuth.key)
      .chat(history, ac.signal)) {
      if (chunk.kind === "reasoning") view.reasoning(chunk.text);
      else {
        reply += chunk.text;
        view.delta(chunk.text);
      }
    }
  } catch (err) {
    if (ac.signal.aborted) out.info("· cancelled");
    else out.error(err instanceof Error ? err.message : String(err));
  } finally {
    view.end();
  }
  if (!reply) process.exitCode = 1;
}

main().catch((err: unknown) => {
  out.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
