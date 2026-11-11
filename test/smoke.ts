/**
 * Smoke test — no API key needed.
 * Spins a mock server speaking BOTH wire protocols (chat-completions and
 * Meta-style responses) and runs the REAL providers and parsers against it.
 * Also exercises the core/out tool-calling loop end to end.
 *
 * Run: bun run test/smoke.ts
 */
import { runTurn } from "../core/out/completion";
import { ToolRegistry } from "../core/middleware/tools/registry";
import { MetaProvider } from "../models/providers/meta";
import { OpenAICompatibleProvider } from "../models/providers/openai-compatible";

const CHUNKS = ["Hello", ", ", "halo", "!"];

function sse(events: unknown[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const event of events) {
        controller.enqueue(
          enc.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const authorized = req.headers.get("authorization") === "Bearer test-key";

    if (url.pathname === "/v1/chat/completions") {
      if (!authorized) {
        return Response.json({ error: { message: "bad key" } }, { status: 401 });
      }
      const body = (await req.json()) as {
        messages?: Array<{ role: string; content: string }>;
        tools?: unknown[];
      };

      // Tool round: with tools advertised, ask for the echo tool; once the
      // tool result comes back, produce the final answer.
      if (body.tools?.length) {
        const sawToolResult = body.messages?.some((m) => m.role === "tool");
        if (!sawToolResult) {
          return sse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "call_1",
                        type: "function",
                        function: { name: "echo", arguments: "" },
                      },
                    ],
                  },
                },
              ],
            },
            // argument JSON split across fragments — must be reassembled
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, function: { arguments: '{"text"' } },
                    ],
                  },
                },
              ],
            },
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, function: { arguments: ':"hi"}' } },
                    ],
                  },
                },
              ],
            },
          ]);
        }
        const toolMsg = body.messages!.find((m) => m.role === "tool")!;
        return sse([
          {
            choices: [{ delta: { content: `tool said ${toolMsg.content}` } }],
          },
        ]);
      }

      return sse([
        { choices: [{ delta: { reasoning_content: "pondering" } }] },
        ...CHUNKS.map((piece) => ({
          choices: [{ delta: { content: piece } }],
        })),
        { choices: [{ delta: {} }] }, // some providers pad like this
      ]);
    }

    if (url.pathname === "/ok/responses") {
      if (!authorized) {
        return Response.json({ error: { message: "bad key" } }, { status: 401 });
      }
      return sse([
        { type: "response.created", response: {} },
        { type: "response.output_text.delta", delta: "Meta " },
        { type: "response.reasoning_summary_text.delta", delta: "thinking..." },
        { type: "response.output_text.delta", delta: "works" },
        { type: "response.completed", response: { status: "completed" } },
      ]);
    }

    if (url.pathname === "/fail/responses") {
      return sse([
        { type: "response.output_text.delta", delta: "partial " },
        {
          type: "response.failed",
          response: { error: { message: "quota exceeded" } },
        },
      ]);
    }

    return new Response("not found", { status: 404 });
  },
});

const port = server.port;
let failures = 0;

// 1. Chat-completions: reasoning_content first, then answer deltas in order.
{
  const provider = new OpenAICompatibleProvider(
    { id: "mock-model", baseURL: `http://localhost:${port}/v1` },
    "test-key",
  );
  let text = "";
  let reasoning = "";
  for await (const chunk of provider.chat(
    [{ role: "user", content: "hi" }],
    { signal: new AbortController().signal },
  )) {
    if (chunk.kind === "reasoning") reasoning += chunk.text;
    else if (chunk.kind === "answer") text += chunk.text;
  }
  if (text !== CHUNKS.join("") || reasoning !== "pondering") {
    console.error(`FAIL: got answer ${JSON.stringify(text)}, reasoning ${JSON.stringify(reasoning)}`);
    failures++;
  } else {
    console.log(`ok  chat-completions: reasoning ${JSON.stringify(reasoning)} -> ${JSON.stringify(text)}`);
  }
}

// 2. Chat-completions auth error surfaces as a readable thrown error.
{
  const bad = new OpenAICompatibleProvider(
    { id: "mock-model", baseURL: `http://localhost:${port}/v1` },
    "wrong-key",
  );
  try {
    for await (const _ of bad.chat(
      [{ role: "user", content: "hi" }],
      { signal: new AbortController().signal },
    )) {
      // drain
    }
    console.error("FAIL: expected 401 to throw");
    failures++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("bad key")) {
      console.log(`ok  chat-completions error path: ${msg}`);
    } else {
      console.error(`FAIL: unexpected error message: ${msg}`);
      failures++;
    }
  }
}

// 3. Meta responses API: reasoning + answer events separated correctly.
{
  const meta = new MetaProvider(
    {
      id: "muse-spark-1.3-contributor",
      baseURL: `http://localhost:${port}/ok`,
      api: "responses",
    },
    "test-key",
  );
  let text = "";
  let reasoning = "";
  for await (const chunk of meta.chat(
    [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ],
    { signal: new AbortController().signal },
  )) {
    if (chunk.kind === "reasoning") reasoning += chunk.text;
    else if (chunk.kind === "answer") text += chunk.text;
  }
  if (text !== "Meta works" || reasoning !== "thinking...") {
    console.error(
      `FAIL: meta answer ${JSON.stringify(text)}, reasoning ${JSON.stringify(reasoning)}`,
    );
    failures++;
  } else {
    console.log(`ok  meta responses: reasoning ${JSON.stringify(reasoning)} -> ${JSON.stringify(text)}`);
  }
}

// 4. Meta mid-stream failure event surfaces as a thrown error.
{
  const meta = new MetaProvider(
    {
      id: "muse-spark-1.3-contributor",
      baseURL: `http://localhost:${port}/fail`,
      api: "responses",
    },
    "test-key",
  );
  try {
    for await (const _ of meta.chat(
      [{ role: "user", content: "hi" }],
      { signal: new AbortController().signal },
    )) {
      // drain
    }
    console.error("FAIL: expected response.failed to throw");
    failures++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("quota exceeded")) {
      console.log(`ok  meta failure event: ${msg}`);
    } else {
      console.error(`FAIL: unexpected meta error: ${msg}`);
      failures++;
    }
  }
}

// 5. core/out tool-calling loop: model asks for a tool, the registry
//    executes it, the result is fed back, final answer arrives.
{
  const provider = new OpenAICompatibleProvider(
    { id: "mock-model", baseURL: `http://localhost:${port}/v1` },
    "test-key",
  );
  const tools = new ToolRegistry();
  tools.register({
    name: "echo",
    description: "echoes its input",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    execute: async (args) => `echo:${args["text"]}`,
  });

  const events: string[] = [];
  let answer = "";
  for await (const event of runTurn({
    provider,
    messages: [{ role: "user", content: "what is 2+2" }],
    tools,
    signal: new AbortController().signal,
  })) {
    events.push(event.type);
    if (event.type === "answer") answer += event.text;
  }

  const call = events[0] === "tool_call";
  const result = events[1] === "tool_result";
  const final = events[2] === "answer" && events.length === 3;
  if (!call || !result || !final || answer !== "tool said echo:hi") {
    console.error(
      `FAIL: tool loop events ${JSON.stringify(events)} answer ${JSON.stringify(answer)}`,
    );
    failures++;
  } else {
    console.log(
      `ok  tool loop: ${events.join(" -> ")} -> ${JSON.stringify(answer)}`,
    );
  }
}

await server.stop(true);
if (failures > 0) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nPASS");
