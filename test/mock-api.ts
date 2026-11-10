/**
 * Mock OpenAI-compatible API for manual end-to-end testing of the CLI
 * without a real key. Stays running and prints its port:
 *
 *   bun run test/mock-api.ts
 *   HALO_API_KEY=test-key HALO_BASE_URL=http://127.0.0.1:<port>/v1 \
 *     bun run src/interface/cli/halo.ts "say hi"
 */
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/chat/completions") {
      return new Response("not found", { status: 404 });
    }
    const body = (await req.json()) as {
      messages?: Array<{ role: string; content: string }>;
    };
    const last = body.messages?.at(-1)?.content ?? "";
    const reply = `You said: "${last}". This is a mock streamed reply.`;

    const stream = new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        // Stream the reply word by word to mimic a real model.
        for (const word of reply.split(/(?<=\s)/)) {
          controller.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`,
            ),
          );
          await new Promise((r) => setTimeout(r, 60));
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

console.log(`PORT=${server.port}`);
setInterval(() => {}, 60_000); // keep alive
