/**
 * Onboarding wizard test — runs the REAL wizard against a throwaway HALO_DIR.
 * No API key needed; the key fed here is fake.
 *
 * Run: HALO_DIR=$(mktemp -d) bash -c 'printf "2\nsk-test-meta-123\n1\n" | bun run test/onboard.ts'
 */
import { InputReader } from "../src/core/in/input";
import { runOnboarding } from "../src/interface/cli/onboard";
import { configPath, loadConfig } from "../src/secrets/config";
import { loadHaloEnv } from "../src/secrets/store";

const reader = new InputReader(() => process.exit(0));
const result = await runOnboarding(reader);
const cfg = await loadConfig();
const env = await loadHaloEnv();
reader.close();

console.log(
  `\nresult: provider=${cfg.provider} model=${cfg.model} api=${cfg.api ?? "-"} ` +
    `envKeys=[${Object.keys(env).join(",")}] savedKey=${result.apiKey ? "yes" : "no"}`,
);
console.log(`config file: ${configPath()}`);

let failed = false;
if (cfg.provider !== "meta") {
  console.error("FAIL: expected provider meta");
  failed = true;
}
if (cfg.model !== "muse-spark-1.3-contributor") {
  console.error("FAIL: expected model muse-spark-1.3-contributor");
  failed = true;
}
if (env.META_API_KEY !== "sk-test-meta-123") {
  console.error("FAIL: key not saved under META_API_KEY");
  failed = true;
}
if (result.apiKey !== "sk-test-meta-123") {
  console.error("FAIL: wizard did not return the key");
  failed = true;
}
if (failed) process.exit(1);
console.log("PASS");
