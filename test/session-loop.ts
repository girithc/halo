/**
 * Session-level tool-loop test — drives the real AgentSession against a
 * mock provider that calls a tool, verifying the TRANSCRIPT SHAPE:
 * each tool round is its own assistant bubble, tool lines sit between
 * them, and the conversation history stores the rounds cleanly joined.
 *
 * Run: bun run test/session-loop.ts
 */
import { AgentSession } from "../core/agent";
import { ToolRegistry, type Tool } from "../core/middleware/tools/registry";

const ANSWER = "FINAL_ANSWER_OK";

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

let round = 0;
const server = Bun.serve({
  port: 0,
  async fetch() {
    round++;
    const events =
      round === 1
        ? [
            { choices: [{ delta: { content: "Let me check. " } }] },
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "echo", arguments: '{"message":"x"}' } }] } }] },
          ]
        : [{ choices: [{ delta: { content: ANSWER } }] }];
    const stream = new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        for (const e of events) {
          c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        }
        c.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});

// A registry whose active model points at the mock.
import { ModelRegistry } from "../models/registry";
const registry = new ModelRegistry({
  id: "mock",
  baseURL: `http://localhost:${server.port}/v1`,
  apiKeyEnv: [],
});

const session = new AgentSession({
  registry,
  getApiKey: async () => "k",
  tools,
  notes: undefined,
});

const snapshots: number[][] = [];
session.subscribe(() => {
  snapshots.push(session.state.entries.map((e) => e.id));
});

await session.send("run the echo tool");

const entries = session.state.entries;
const roles = entries.map((e) => e.role);

let failures = 0;
const expect = (cond: boolean, why: string) => {
  if (cond) {
    console.log(`ok  ${why}`);
  } else {
    console.error(`FAIL: ${why}`);
    failures++;
  }
};

expect(roles[0] === "user", "first entry is the user turn");
expect(
  roles.filter((r) => r === "assistant").length === 2,
  "two assistant bubbles (one per tool round)",
);
expect(
  roles.indexOf("info") > roles.indexOf("assistant") &&
    roles.lastIndexOf("assistant") > roles.lastIndexOf("info"),
  "tool call/result lines sit between the two bubbles",
);
expect(
  entries.some((e) => e.role === "info" && e.text.startsWith("⚙ echo")),
  "tool call logged with ⚙",
);
expect(
  entries.some((e) => e.role === "info" && e.text.startsWith("↳ ECHO:")),
  "tool result logged with ↳",
);
expect(
  entries.some((e) => e.role === "assistant" && e.text.includes(ANSWER)),
  "final answer in the second bubble",
);
// The multi-round reply must be in history joined with a blank line —
// verified indirectly: no entry contains the two rounds CONCATENATED
// without a separator.
expect(
  !entries.some((e) => e.text.includes("Let me check. FINAL_ANSWER_OK")),
  "rounds are not concatenated without separator",
);

await server.stop(true);
if (failures > 0) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nPASS");
