import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Persisted user preferences, stored as ~/.halo/config.json. */
export interface HaloConfig {
  model?: string;
  baseURL?: string;
}

function configDir(): string {
  return join(homedir(), ".halo");
}

/** Path of the config file, shown in /config output. */
export function configPath(): string {
  return join(configDir(), "config.json");
}

export async function loadConfig(): Promise<HaloConfig> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as HaloConfig;
  } catch {
    return {};
  }
}

export async function saveConfig(patch: Partial<HaloConfig>): Promise<string> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  const next = { ...(await loadConfig()), ...patch };
  await writeFile(configPath(), JSON.stringify(next, null, 2) + "\n");
  return configPath();
}
