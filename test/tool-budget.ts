/**
 * Tool-budget test — when the model exhausts maxToolRounds (never stops
 * asking for tools), runTurn must force a final wrap-up round WITHOUT
 * advertising tools, so the turn always ends with an answer.
 *
 * Run: bun run test/tool-budget.ts
 */
import { runTurn } from "../core/out/completion";
import { ToolRegistry, type Tool } from "../core/middleware/tools/registry";
import { OpenAICompatibleProvider } from "../models/providers/openai-compatible";

const ANSWER = "WRAPPED_UP_OK";

const echoTool: Tool = {
  name: "echo",
  description: "echo",
  parameters: { type: "object", properties: { message: { type: "string" } } },
  async execute(args) {
    return `ECHO:${String(args.message ?? "")}`;
  },
};

const tools = new ToolRegistry();
tools.register(echoTool);

// The mock: as long as the request advertises tools, ask for the echo
// tool again (a model that never stops). The first request WITHOUT
// tools gets the final answer.
let toolAdvertisedRounds = 0;
let plainRounds = 0;
const requests: any[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { tools?: unknown[] };
    requests.push(body);
    if (body.tools?.length) {
      toolAdvertisedRounds++;
      const stream = new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(
            enc.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${toolAdvertisedRounds}`, function: { name: "echo", arguments: '{"message":"x"}' } }] } }] })}\n\n`,
            ),
          );
          c.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    plainRounds++;
    const stream = new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: ANSWER } }] })}\n\n`));
        c.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});

const events: string[] = [];
for await (const event of runTurn({
  provider: new OpenAICompatibleProvider(
    { id: "mock", baseURL: `http://localhost:${server.port}/v1` },
    "k",
  ),
  messages: [{ role: "user", content: "keep calling tools forever" }],
  tools,
  maxToolRounds: 3,
  signal: new AbortController().signal,
})) {
  events.push(event.type === "answer" ? `answer:${event.text}` : event.type);
}
await server.stop(true);

let failures = 0;
const expect = (cond: boolean, why: string) => {
  if (cond) console.log(`ok  ${why}`);
  else {
    console.error(`FAIL: ${why}`);
    failures++;
  }
};

expect(toolAdvertisedRounds === 3, "model ran the full tool budget (3 rounds)");
expect(plainRounds === 1, "wrap-up round ran without advertising tools");
expect(events.filter((e) => e === "tool_call").length === 3, "three tool calls executed");
expect(events.includes(`answer:${ANSWER}`), "turn ended with a real answer");
expect(events[events.length - 1]!.startsWith("answer:"), "last event is the answer");

if (failures > 0) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nPASS");
