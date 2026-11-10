import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Persisted user preferences, stored as ~/.halo/config.json. */
export interface HaloConfig {
  provider?: string;
  model?: string;
  baseURL?: string;
  api?: "chat-completions" | "responses";
  apiKeyEnv?: string[];
  reasoningEffort?: "low" | "medium" | "high";
}

/** Root of halo's machine-wide store; override with HALO_DIR (tests use this). */
export function haloDir(): string {
  return process.env.HALO_DIR ?? join(homedir(), ".halo");
}

/** Path of the config file, shown in /config output. */
export function configPath(): string {
  return join(haloDir(), "config.json");
}

export async function loadConfig(): Promise<HaloConfig> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as HaloConfig;
  } catch {
    return {};
  }
}

export async function saveConfig(patch: Partial<HaloConfig>): Promise<string> {
  await mkdir(haloDir(), { recursive: true, mode: 0o700 });
  const next = { ...(await loadConfig()), ...patch };
  await writeFile(configPath(), JSON.stringify(next, null, 2) + "\n");
  return configPath();
}
