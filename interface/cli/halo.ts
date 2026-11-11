#!/usr/bin/env bun
/**
 * halo — terminal coding agent (CLI entry point).
 *
 *   halo              full TUI session (first run: setup wizard)
 *   halo "prompt"     one-shot plain answer
 *
 * The whole interface layer is presentation: this file wires the core
 * (in → out) to the terminal — model/config resolution, the onboarding
 * wizard, slash commands, the one-shot stream, and launching the TUI.
 * All chat behaviour lives in core/in + core/out.
 */
import { render } from "ink";
import { createElement } from "react";
import { AgentSession } from "../../core/agent";
import { gatherContext, SYSTEM_PROMPT } from "../../core/in/context";
import { InputReader, CANCEL } from "../../core/in/input";
import { runTurn } from "../../core/out/completion";
import { App, type CommandHandler } from "./App";
import { bold, dim } from "./terminal";
import * as out from "./terminal";
import {
  DEFAULT_MODEL,
  MODEL_PRESETS,
  ModelRegistry,
  PROVIDER_MODELS,
  needsApiKey,
} from "../../models/registry";
import type { ModelConfig } from "../../models/types";
import { configPath, loadConfig, saveConfig } from "../../secrets/config";
import { maskKey, resolveApiKey, saveApiKey, type ApiKey } from "../../secrets/store";

const VERSION = "0.1.0";

// ---- entry ------------------------------------------------------------------

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

  // The headless conductor: context gathering (in) + completion loop (out).
  const session = new AgentSession({
    registry,
    getApiKey: async () =>
      (await resolveApiKey(registry.active().apiKeyEnv))?.key ?? apiKey,
    systemPrompt: SYSTEM_PROMPT,
  });

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
      createElement(App, {
        session,
        commands: createCommandHandler(registry, session, () => process.exit(0)),
      }),
      { exitOnCtrlC: false },
    );
    await waitUntilExit();
  } finally {
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  }
  out.info("bye 👋");
}

// ---- first-run onboarding -----------------------------------------------------

export interface OnboardResult {
  /** Full config (preset + chosen model id) to activate immediately. */
  config: ModelConfig;
  /** The key as typed — undefined for local providers. */
  apiKey?: string;
}

/**
 * First-run onboarding wizard:
 *   1. pick a provider (numbered list)
 *   2. paste its API key (skipped for local providers)
 *   3. pick a model (numbered list, last option = type any model id)
 * Everything is persisted: key → ~/.halo/.env, choice → ~/.halo/config.json.
 */
export async function runOnboarding(reader: InputReader): Promise<OnboardResult> {
  console.log();
  out.info("first run — three quick questions (everything saved to ~/.halo)");
  console.log();

  // 1. Provider
  const names = Object.keys(MODEL_PRESETS);
  console.log(`  ${bold("1. choose a provider:")}`);
  names.forEach((name, i) => {
    const preset = MODEL_PRESETS[name]!;
    const local = needsApiKey(preset) ? "" : dim("   (local — no key)");
    console.log(
      `    ${i + 1}) ${name.padEnd(12)}${dim(`${preset.id} @ ${preset.baseURL}`)}${local}`,
    );
  });
  const providerName = await pickOption(reader, "provider", names, names[0]!);
  const preset = MODEL_PRESETS[providerName]!;
  console.log();

  // 2. API key
  let apiKey: string | undefined;
  console.log(`  ${bold("2. API key")}`);
  if (needsApiKey(preset)) {
    console.log(dim("    stored in ~/.halo/.env (mode 600), never committed"));
    apiKey = await askKey(reader, providerName, preset);
  } else {
    console.log(dim("    not needed for local providers"));
  }
  console.log();

  // 3. Model
  const models = PROVIDER_MODELS[providerName] ?? [];
  console.log(`  ${bold("3. choose a model:")}`);
  let modelId: string;
  if (models.length > 0) {
    models.forEach((m, i) => console.log(`    ${i + 1}) ${m}`));
    console.log(`    ${models.length + 1}) other — type a model id`);
    const options = [...models, CUSTOM];
    const choice = await pickOption(reader, "model", options, models[0]!);
    modelId = choice === CUSTOM ? await askModelId(reader) : choice;
  } else {
    modelId = await askModelId(reader);
  }

  const config: ModelConfig = { ...preset, id: modelId };
  const path = await saveConfig({
    provider: providerName,
    model: modelId,
    baseURL: config.baseURL,
    api: config.api,
    apiKeyEnv: config.apiKeyEnv,
  });
  out.success(`saved ${providerName} · ${modelId} → ${configPath()}`);

  return { config, apiKey };
}

const CUSTOM = "__custom__";

/** Numbered-menu picker: accepts a number or an exact name, Enter = default. */
async function pickOption(
  reader: InputReader,
  label: string,
  options: string[],
  fallback: string,
): Promise<string> {
  for (;;) {
    const raw = await reader.readLine(
      `${label}? [1-${options.length}, enter=${fallback}]: `,
    );
    const answer = raw.trim();
    if (answer === CANCEL) throw new Error("cancelled");
    if (!answer) return fallback;
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) {
      return options[n - 1]!;
    }
    const byName = options.find((o) => o.toLowerCase() === answer.toLowerCase());
    if (byName) return byName;
    out.error(`pick 1-${options.length} or a name from the list`);
  }
}

async function askKey(
  reader: InputReader,
  providerName: string,
  preset: ModelConfig,
): Promise<string> {
  for (;;) {
    const raw = await reader.readLine(`  API key for ${providerName}: `);
    const key = raw.trim();
    if (key === CANCEL) throw new Error("cancelled");
    if (!key) {
      out.error("key cannot be empty (ctrl-c to cancel)");
      continue;
    }
    const envName = preset.apiKeyEnv?.[0] ?? "HALO_API_KEY";
    const path = await saveApiKey(envName, key);
    out.success(`key ${maskKey(key)} saved to ${path}`);
    return key;
  }
}

async function askModelId(reader: InputReader): Promise<string> {
  for (;;) {
    const raw = await reader.readLine("model id: ");
    const id = raw.trim();
    if (id === CANCEL) throw new Error("cancelled");
    if (id) return id;
    out.error("model id cannot be empty");
  }
}

// ---- slash commands -------------------------------------------------------------

const HELP_TEXT = [
  "commands:",
  "  /model                show the active model",
  "  /model <id|preset>    switch model for this session (presets: " +
    Object.keys(MODEL_PRESETS).join(", ") + ")",
  "  /config               persist current setup to ~/.halo/config.json",
  "  /clear                reset conversation history",
  "  /quit                 exit",
  "keys:",
  "  esc                   interrupt the current reply",
  "  ctrl-c                interrupt (or quit when idle)",
].join("\n");

/**
 * Slash commands — configuration UX (registry, config files, terminal);
 * the session handles messages, this handles everything starting with /.
 */
function createCommandHandler(
  registry: ModelRegistry,
  session: AgentSession,
  exit: () => void,
): CommandHandler {
  return {
    async run(name, args) {
      switch (name.toLowerCase()) {
        case "help":
          session.info(HELP_TEXT);
          return;
        case "model": {
          if (!args) {
            const active = registry.active();
            session.info(`active model: ${active.id} @ ${active.baseURL}`);
            return;
          }
          const preset = MODEL_PRESETS[args.toLowerCase()];
          if (preset) {
            registry.setConfig(preset);
            session.info(`✓ ${preset.id} @ ${preset.baseURL} (session only)`);
          } else {
            registry.setModelId(args);
            session.info(`✓ model set to ${args} (session only — /config persists)`);
          }
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
            reasoningEffort: active.reasoningEffort,
          });
          session.info(`✓ saved ${active.id} → ${path}`);
          return;
        }
        case "clear":
          session.clear();
          return;
        case "quit":
        case "exit":
        case "q":
          exit();
          return;
        default:
          session.info(`unknown command /${name} — try /help`);
      }
    },
  };
}

// ---- one-shot mode ---------------------------------------------------------------

/** One-shot streaming to stdout, no TUI. Runs the same core/out loop. */
async function plainSend(
  registry: ModelRegistry,
  apiKey: string,
  text: string,
): Promise<void> {
  const view = out.createStreamView(`waiting · ${registry.active().id}`);
  const ac = new AbortController();
  let reply = "";
  try {
    const requestAuth =
      (await resolveApiKey(registry.active().apiKeyEnv)) ?? { key: apiKey, source: "" };
    const provider = registry.createProvider(requestAuth.key);
    const messages = gatherContext([], text, { systemPrompt: SYSTEM_PROMPT });
    for await (const event of runTurn({ provider, messages, signal: ac.signal })) {
      if (event.type === "reasoning") view.reasoning(event.text);
      else if (event.type === "answer") {
        reply += event.text;
        view.delta(event.text);
      } else if (event.type === "tool_call") {
        view.reasoning(`\n[tool] ${event.call.name}(${event.call.arguments})\n`);
      } else if (event.type === "tool_result") {
        view.reasoning(`[result] ${event.result}\n`);
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

// Run only when executed directly — tests import helpers from this file.
if (import.meta.main) {
  main().catch((err: unknown) => {
    out.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
