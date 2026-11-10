/**
 * Smoke test — no API key needed.
 * Spins a mock OpenAI-compatible SSE server and runs the REAL provider
 * and stream parser against it, plus the auth-error path.
 *
 * Run: bun run test/smoke.ts
 */
import { OpenAICompatibleProvider } from "../src/models/providers/openai-compatible";

const CHUNKS = ["Hello", ", ", "halo", "!"];

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/chat/completions") {
      return new Response("not found", { status: 404 });
    }
    if (req.headers.get("authorization") !== "Bearer test-key") {
      return Response.json({ error: { message: "bad key" } }, { status: 401 });
    }
    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        for (const piece of CHUNKS) {
          const payload = { choices: [{ delta: { content: piece } }] };
          controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));
          await new Promise((r) => setTimeout(r, 25));
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    });
  },
});

let failures = 0;

// 1. Happy path: deltas stream out in order and assemble exactly.
{
  const provider = new OpenAICompatibleProvider(
    { id: "mock-model", baseURL: `http://localhost:${server.port}/v1` },
    "test-key",
  );
  let text = "";
  let chunks = 0;
  for await (const chunk of provider.chat(
    [{ role: "user", content: "hi" }],
    new AbortController().signal,
  )) {
    text += chunk.delta;
    chunks++;
  }
  const expected = CHUNKS.join("");
  if (text !== expected || chunks !== CHUNKS.length) {
    console.error(`FAIL: got ${JSON.stringify(text)} in ${chunks} chunks`);
    failures++;
  } else {
    console.log(`ok  streaming: ${chunks} chunks -> ${JSON.stringify(text)}`);
  }
}

// 2. Auth error: a 401 must surface as a readable thrown error.
{
  const bad = new OpenAICompatibleProvider(
    { id: "mock-model", baseURL: `http://localhost:${server.port}/v1` },
    "wrong-key",
  );
  try {
    for await (const _ of bad.chat(
      [{ role: "user", content: "hi" }],
      new AbortController().signal,
    )) {
      // drain
    }
    console.error("FAIL: expected 401 to throw");
    failures++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("bad key")) {
      console.log(`ok  error path: ${msg}`);
    } else {
      console.error(`FAIL: unexpected error message: ${msg}`);
      failures++;
    }
  }
}

await server.stop(true);
if (failures > 0) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nPASS");
