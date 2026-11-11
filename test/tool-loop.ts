/**
 * Tool-loop smoke test — verifies runTurn executes tool calls through
 * BOTH wire protocols: the model asks for a tool, the loop runs it,
 * feeds the result back, and the model answers. No API key needed.
 *
 * Run: bun run test/tool-loop.ts
 */
import { runTurn } from "../core/out/completion";
import { ToolRegistry, type Tool } from "../core/middleware/tools/registry";
import { MetaProvider } from "../models/providers/meta";
import { OpenAICompatibleProvider } from "../models/providers/openai-compatible";

const ECHO_ANSWER = "TOOL_LOOP_OK: the tool said ECHO_MARKER";

// A stub tool the model can call.
const echoTool: Tool = {
  name: "echo",
  description: "echo the message back",
  parameters: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
  },
  async execute(args) {
    return `ECHO_MARKER:${String(args.message ?? "")}`;
  },
};

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  return registry;
}

let failures = 0;

/** Shared assertions over one provider + protocol mock. */
function sse(events: unknown[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const event of events) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream" },
  });
}




// --- chat-completions ---
await (async () => {
  const requests: any[] = [];
  let round = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      round++;
      const body = await req.json();
      requests.push(body);
      if (round === 1) {
        return sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "echo", arguments: "" } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"message":"hi"}' } }] } }] },
        ]);
      }
      return sse([{ choices: [{ delta: { content: ECHO_ANSWER } }] }]);
    },
  });
  const events: string[] = [];
  for await (const event of runTurn({
    provider: new OpenAICompatibleProvider(
      { id: "mock", baseURL: `http://localhost:${server.port}/v1` },
      "k",
    ),
    messages: [{ role: "user", content: "echo hi please" }],
    tools: makeRegistry(),
    signal: new AbortController().signal,
  })) {
    events.push(event.type === "answer" ? `answer:${event.text}` : event.type);
  }
  const second = JSON.stringify(requests[1] ?? {});
  const problems: string[] = [];
  if (!events.includes("tool_call")) problems.push("no tool_call");
  if (!events.includes("tool_result")) problems.push("no tool_result");
  if (!events.some((e) => e.startsWith("answer:TOOL_LOOP_OK"))) problems.push("no final answer");
  if (!second.includes('"tool"')) problems.push("tool result not in 2nd request");
  if (problems.length) {
    console.error(`FAIL: chat-completions loop — ${problems.join("; ")}`);
    failures++;
  } else {
    console.log("ok  chat-completions loop: tool executed, result fed back, answer streamed");
  }
  await server.stop(true);
})();

// --- meta responses ---
await (async () => {
  const requests: any[] = [];
  let round = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      round++;
      const body = await req.json();
      requests.push(body);
      if (round === 1) {
        // Advertise-time sanity: the request should carry our tools.
        if (!body.tools?.length) {
          return sse([{ type: "response.failed", response: { error: { message: "no tools advertised" } } }]);
        }
        return sse([
          { type: "response.created", response: {} },
          {
            type: "response.output_item.added",
            item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "echo", arguments: "" },
          },
          { type: "response.function_call_arguments.delta", delta: '{"message"' },
          { type: "response.function_call_arguments.delta", delta: ':"hi"}' },
          {
            type: "response.output_item.done",
            item: { id: "fc_1", type: "function_call", call_id: "call_1", name: "echo", arguments: '{"message":"hi"}' },
          },
          { type: "response.completed", response: { status: "completed" } },
        ]);
      }
      // Second round: the request must carry the function_call_output result.
      return sse([
        { type: "response.output_item.added", item: { id: "msg_1", type: "message", role: "assistant" } },
        { type: "response.output_text.delta", delta: ECHO_ANSWER },
        { type: "response.completed", response: { status: "completed" } },
      ]);
    },
  });
  const events: string[] = [];
  for await (const event of runTurn({
    provider: new MetaProvider(
      { id: "muse", baseURL: `http://localhost:${server.port}/v1`, api: "responses" },
      "k",
    ),
    messages: [{ role: "user", content: "echo hi please" }],
    tools: makeRegistry(),
    signal: new AbortController().signal,
  })) {
    events.push(event.type === "answer" ? `answer:${event.text}` : event.type);
  }
  const second = JSON.stringify(requests[1] ?? {});
  const problems: string[] = [];
  if (!requests[0]?.tools?.length) problems.push("tools not advertised in request 1");
  if (!events.includes("tool_call")) problems.push("no tool_call");
  if (!events.includes("tool_result")) problems.push("no tool_result");
  if (!second.includes("function_call_output")) problems.push("function_call_output not in 2nd request");
  if (!events.some((e) => e.startsWith("answer:TOOL_LOOP_OK"))) problems.push("no final answer");
  if (problems.length) {
    console.error(`FAIL: meta loop — ${problems.join("; ")}`);
    failures++;
  } else {
    console.log("ok  meta loop: tools advertised, function_call parsed, output fed back, answer streamed");
  }
  await server.stop(true);
})();

if (failures > 0) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nPASS");
