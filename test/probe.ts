/**
 * Transport probe: replicates MetaProvider's exact fetch using Bun,
 * and dumps the raw response start. Diagnoses "curl works, halo hangs".
 *
 * Run: bun run test/probe.ts
 */
export {};

const key = process.env.META_API_KEY ?? process.env.MODEL_API_KEY ?? process.env.HALO_API_KEY;
if (!key) {
  console.error("no key in env");
  process.exit(1);
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 45_000);

const started = Date.now();
const res = await fetch("https://api.meta.ai/v1/responses", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    Authorization: `Bearer ${key}`,
  },
  body: JSON.stringify({
    model: "muse-spark-1.3-contributor",
    input: [
      { role: "system", content: "You are halo, a concise terminal coding agent." },
      { role: "user", content: "hello" },
    ],
    stream: true,
  }),
  signal: controller.signal,
});
clearTimeout(timer);

console.log(`status: ${res.status} after ${Date.now() - started}ms`);
console.log(`content-type: ${res.headers.get("content-type")}`);
console.log(`server: ${res.headers.get("server")}`);

if (!res.body) {
  console.error("no body");
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let shown = 0;
const MAX_CHARS = 2500;
try {
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    process.stdout.write(decoder.decode(value, { stream: true }));
    shown += value.length;
    if (shown > MAX_CHARS) break;
  }
} catch (err) {
  console.error(`\n[read error after ${Date.now() - started}ms]: ${err}`);
}
console.log(`\n[total bytes: ${shown}, elapsed ${Date.now() - started}ms]`);
