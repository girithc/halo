/**
 * Visual rendering check for renderChat — code panels keep indentation,
 * and halo ❯ shows once per user request (continuation rounds after
 * tool lines flow without the prefix). No API key needed.
 *
 * Run: bun run test/wrap-visual.ts
 */
import { renderChat } from "../interface/cli/terminal";

// --- 1. code panels keep indentation + render as panels ---
const panel = renderChat(
  [
    {
      id: 1,
      role: "assistant",
      text:
        "`ToolRegistry` lives in:\n\n```\nexport class ToolRegistry {\n" +
        "  register(tool: Tool): void\n  get(name: string): Tool | undefined\n}\n```",
    },
  ],
  { width: 60, busy: false, frame: "⠋", elapsed: 0, modelId: "m" },
);

console.log(panel.map((l) => `${l.bgColor ? "[panel]" : "      "}${l.text}`).join("\n"));

let failures = 0;
const expect = (cond: boolean, why: string) => {
  if (cond) console.log(`ok  ${why}`);
  else {
    console.error(`FAIL: ${why}`);
    failures++;
  }
};

expect(
  panel.some((l) => l.bgColor && l.text.trim() === "export class ToolRegistry {"),
  "code block renders as a panel",
);
expect(
  panel.some((l) => l.bgColor && l.text.trim().startsWith("register(tool: Tool)")),
  "code indentation survives inside the panel",
);
expect(!panel.some((l) => l.text.includes("```")), "fence markers never render");

// --- 2. halo ❯ shows once per user request ---
const multi = renderChat(
  [
    { id: 1, role: "user", text: "where is the registry?" },
    { id: 2, role: "assistant", text: "Looking now." },
    { id: 3, role: "info", text: "⚙ file_search()" },
    { id: 4, role: "info", text: "↳ core/middleware/tools/registry.ts" },
    { id: 5, role: "assistant", text: "It is in core/middleware/tools/registry.ts." },
    { id: 6, role: "user", text: "thanks" },
  ],
  { width: 60, busy: false, frame: "⠋", elapsed: 0, modelId: "m" },
);

const assistantRows = multi.filter((l) => !l.bgColor && l.prefix !== undefined && l.prefixColor === "cyan");
const firstBubble = multi[multi.findIndex((l) => l.text.includes("Looking"))]!;
const secondBubble = multi[multi.findIndex((l) => l.text.includes("It is in"))]!;
expect(firstBubble.prefix === "halo ❯ ", "first bubble after request carries halo ❯");
expect(secondBubble.prefix === "  ", "continuation bubble flows without halo ❯");
expect(
  multi[1]?.prefix === "you ❯ ",
  "user rows keep their prefix (row 1 — row 0 is the gap blank)",
);
void assistantRows;

if (failures > 0) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nPASS");
