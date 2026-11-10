/**
 * First-run onboarding wizard:
 *   1. pick a provider (numbered list)
 *   2. paste its API key (skipped for local providers)
 *   3. pick a model (numbered list, last option = type any model id)
 * Everything is persisted: key → ~/.halo/.env, choice → ~/.halo/config.json.
 */
import { InputReader, CANCEL } from "../../core/in/input";
import * as out from "../../core/out/output";
import { bold, dim } from "../../core/out/output";
import {
  MODEL_PRESETS,
  PROVIDER_MODELS,
  needsApiKey,
} from "../../models/registry";
import type { ModelConfig } from "../../models/types";
import { configPath, saveConfig } from "../../secrets/config";
import { maskKey, saveApiKey } from "../../secrets/store";

export interface OnboardResult {
  /** Full config (preset + chosen model id) to activate immediately. */
  config: ModelConfig;
  /** The key as typed — undefined for local providers. */
  apiKey?: string;
}

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
  const providerName = await pickOption(
    reader,
    "provider",
    names,
    names[0]!,
  );
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
    modelId =
      choice === CUSTOM ? await askModelId(reader) : choice;
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
    const byName = options.find(
      (o) => o.toLowerCase() === answer.toLowerCase(),
    );
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
