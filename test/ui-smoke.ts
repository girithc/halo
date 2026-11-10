/**
 * UI smoke test — renders the REAL Ink app with a mock provider and an
 * auto-sent initial prompt. Verifies the TUI mounts, streams a reply,
 * and completes, without needing a TTY or API key.
 *
 * Run: bun run test/ui-smoke.ts
 */
import { render } from "ink";
import { Writable } from "node:stream";
import type { WriteStream } from "node:tty";
import { createElement } from "react";
import { App } from "../interface/cli/ui/App";
import { ModelRegistry } from "../models/registry";

const MARKER = "MOCK_ANSWER_MARKER_OK";

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/v1/chat/completions") {
      return new Response("not found", { status: 404 });
    }
    return Response.json({
      choices: [{ message: { content: `The app is alive: ${MARKER}` } }],
    });
  },
});

// Ink's official capture path: pass a custom stdout stream.
const frames: string[] = [];
const fakeStdout = new Writable({
  write(chunk, _enc, cb) {
    frames.push(String(chunk));
    cb();
  },
});
const stdoutAny = fakeStdout as Writable & { columns?: number; rows?: number };
stdoutAny.columns = 100;
stdoutAny.rows = 40;

const registry = new ModelRegistry({
  name: "mock",
  id: "mock-model",
  baseURL: `http://localhost:${server.port}/v1`,
  apiKeyEnv: [],
});

const { waitUntilExit } = render(
  createElement(App, {
    registry,
    apiKey: "test-key",
    interactive: false,
    initialPrompt: "say hi",
  }),
  {
    stdout: fakeStdout as unknown as WriteStream,
    exitOnCtrlC: false,
    patchConsole: false,
  },
);

const timeout = setTimeout(() => {
  console.error("FAIL: app did not finish within 15s");
  process.exit(1);
}, 15_000);

await waitUntilExit();
clearTimeout(timeout);

const painted = frames.join("");
if (painted.includes(MARKER) && painted.includes("halo ❯")) {
  console.log("ok  ui smoke: TUI mounted, streamed and completed the turn");
  process.exit(0);
} else {
  console.error("FAIL: marker not found in painted output");
  console.error(painted.slice(-600));
  process.exit(1);
}
