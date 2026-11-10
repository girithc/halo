import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { haloDir } from "./config";

/** Key names halo looks for, in order. */
const ENV_KEYS = [
  "HALO_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GROQ_API_KEY",
  "META_API_KEY",
] as const;

function envFilePath(): string {
  return join(haloDir(), ".env");
}

export interface ApiKey {
  key: string;
  /** Where the key was found, shown in the banner. */
  source: string;
}

/** Minimal .env parser — enough for KEY=VALUE lines with optional quotes. */
function parseDotEnv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** Reads ~/.halo/.env if it exists. */
export async function loadHaloEnv(): Promise<Record<string, string>> {
  try {
    return parseDotEnv(await readFile(envFilePath(), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Finds an API key. `prefer` lists env names the active provider likes
 * (e.g. META_API_KEY for api.meta.ai); those are checked first, then
 * every known name. Env beats file at each step.
 */
export async function resolveApiKey(
  prefer: readonly string[] = [],
): Promise<ApiKey | null> {
  const order = [...prefer, ...ENV_KEYS.filter((k) => !prefer.includes(k))];
  for (const name of order) {
    const fromEnv = process.env[name];
    if (fromEnv) return { key: fromEnv, source: name };
  }
  const file = await loadHaloEnv();
  for (const name of order) {
    const fromFile = file[name];
    if (fromFile) return { key: fromFile, source: envFilePath() };
  }
  return null;
}

/** Saves `key` under env var `name` in ~/.halo/.env (mode 600), preserving other entries. */
export async function saveApiKey(name: string, key: string): Promise<string> {
  await mkdir(haloDir(), { recursive: true, mode: 0o700 });
  const merged = await loadHaloEnv();
  merged[name] = key;
  const body =
    Object.entries(merged)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
  await writeFile(envFilePath(), body, { mode: 0o600 });
  return envFilePath();
}

/** Never show a full key back in the terminal. */
export function maskKey(key: string): string {
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}
