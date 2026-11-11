/**
 * File tools smoke test — exercises search/read/create/edit for real
 * inside a temp project root. No API key needed.
 *
 * Run: bun run test/tools-files.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFileTools } from "../core/middleware/tools/files";
import { ToolRegistry } from "../core/middleware/tools/registry";

const root = mkdtempSync(join(tmpdir(), "halo-tools-"));
const registry = registerFileTools(new ToolRegistry(), root);

let failures = 0;
async function check(label: string, actual: string, expectedIncludes: string[]): Promise<void> {
  const ok = expectedIncludes.every((s) => actual.includes(s));
  if (ok) {
    console.log(`ok  ${label}`);
  } else {
    console.error(`FAIL: ${label}\n  got: ${JSON.stringify(actual.slice(0, 200))}`);
    failures++;
  }
}

const run = (name: string, args: Record<string, unknown>) => {
  const tool = registry.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.execute(args);
};

// create
await check(
  "create a new file",
  await run("file_create", { path: "src/greet.ts", content: "export const greeting = 'hello';\n" }),
  ["created", "src/greet.ts"],
);
await check(
  "create refuses overwrite",
  await run("file_create", { path: "src/greet.ts", content: "nope" }),
  ["already exists", "file_edit"],
);

// edit
await check(
  "edit replaces text",
  await run("file_edit", { path: "src/greet.ts", find: "hello", replace: "hola" }),
  ["edited", "1 occurrence"],
);
await check(
  "edit refuses missing text",
  await run("file_edit", { path: "src/greet.ts", find: "nope-nope", replace: "x" }),
  ["not found"],
);

// read
await check(
  "read returns numbered lines",
  await run("file_read", { path: "src/greet.ts" }),
  ["greet.ts", "1 |", "hola"],
);
await check(
  "read rejects escaping paths",
  await run("file_read", { path: "../../etc/hosts" }),
  ["error", "escapes"],
);

// search
await check(
  "search finds content",
  await run("file_search", { query: "hola" }),
  ["src/greet.ts:1"],
);
await check(
  "search finds by name (nameOnly)",
  await run("file_search", { query: "greet", nameOnly: true }),
  ["src/greet.ts"],
);

rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nPASS");
