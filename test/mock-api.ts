/**
 * Mock backend for manual end-to-end testing of the CLI without real keys.
 * Speaks BOTH wire protocols and stays running, printing its port:
 *
 *   bun run test/mock-api.ts
 *   HALO_API_KEY=test-key HALO_BASE_URL=http://127.0.0.1:<port>/v1 \
 *     bun run src/interface/cli/halo.ts "say hi"
 */
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);

    // --- OpenAI chat-completions protocol ---
    if (url.pathname === "/v1/chat/completions") {
      const body = (await req.json()) as {
        messages?: Array<{ role: string; content: string }>;
      };
      const last = body.messages?.at(-1)?.content ?? "";
      const reply = `You said: "${last}". This is a mock streamed reply.`;

      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          // reasoning first, like deepseek-reasoner
          controller.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Thinking about the reply..." } }] })}\n\n`,
            ),
          );
          await new Promise((r) => setTimeout(r, 400));
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
    }

    // --- Meta responses protocol (api.meta.ai style) ---
    if (url.pathname === "/v1/responses") {
      const body = (await req.json()) as {
        input?: Array<{ role: string; content: string }>;
      };
      const last = body.input?.at(-1)?.content ?? "";
      const reply = `You said: "${last}". This is a mock streamed reply.`;

      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          // reasoning first, like a real reasoning model
          controller.enqueue(
            enc.encode(
              `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "The user greeted me. I'll reply warmly." })}\n\n`,
            ),
          );
          await new Promise((r) => setTimeout(r, 400));
          for (const word of reply.split(/(?<=\s)/)) {
            controller.enqueue(
              enc.encode(
                `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: word })}\n\n`,
              ),
            );
            await new Promise((r) => setTimeout(r, 60));
          }
          controller.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`PORT=${server.port}`);
setInterval(() => {}, 60_000); // keep alive
