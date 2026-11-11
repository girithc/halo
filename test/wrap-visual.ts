/**
 * Visual rendering check for renderChat — code panels keep indentation,
 * and halo ❯ shows once per user request (continuation rounds after
 * tool lines flow without the prefix). No API key needed.
 *
 * Run: bun run test/wrap-visual.ts
 */
import { renderChat } from "../interface/cli/terminal";

const isPanelRow = (l: { bgColor?: string; parts?: Array<{ bgColor?: string }> }): boolean =>
  l.parts?.length ? l.parts.every((p) => p.bgColor === "#262626") : l.bgColor === "#262626";


const rowText = (l: { text: string; parts?: Array<{ text: string }> }): string =>
  l.parts ? l.parts.map((p) => p.text).join("") : l.text;


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

// panel rows = every part carries the panel bg
expect(
  panel.some((l) => isPanelRow(l) && rowText(l).trim() === "export class ToolRegistry {"),
  "code block renders as a panel",
);
expect(
  panel.some((l) => isPanelRow(l) && rowText(l).trim().startsWith("register(tool: Tool)")),
  "code indentation survives inside the panel",
);
expect(!panel.some((l) => rowText(l).includes("```")), "fence markers never render");
const kwRow = panel.find((l) => isPanelRow(l) && rowText(l).includes("export class"))!;
expect(
  kwRow.parts!.some((p) => p.text.trim() === "export" && p.color === "#569CD6"),
  "keywords are VS Code blue",
);
expect(
  kwRow.parts!.some((p) => p.text === "ToolRegistry" && p.color === "#4EC9B0"),
  "class names are VS Code teal",
);

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
const firstBubble = multi[multi.findIndex((l) => rowText(l).includes("Looking"))]!;
const secondBubble = multi[multi.findIndex((l) => rowText(l).includes("It is in"))]!;
expect(firstBubble.prefix === "halo ❯ ", "first bubble after request carries halo ❯");
expect(secondBubble.prefix === "  ", "continuation bubble flows without halo ❯");
expect(
  multi[1]?.prefix === "you ❯ ",
  "user rows keep their prefix (row 1 — row 0 is the gap blank)",
);
void assistantRows;

// --- 3. inline `code` chips render as blue parts, backticks dropped ---
const inline = renderChat(
  [{ id: 1, role: "assistant", text: "`ToolRegistry` lives in:" }],
  { width: 60, busy: false, frame: "⠋", elapsed: 0, modelId: "m" },
);
const chipRow = inline.find((l) => l.parts?.length)!;
expect(
  chipRow.parts!.some((p) => p.text === "ToolRegistry" && p.color === "blue"),
  "inline code renders as a blue chip",
);
expect(!chipRow.parts!.some((p) => p.text.includes("`")), "backticks are not rendered");
expect(
  chipRow.parts!.map((p) => p.text).join("").includes("lives in:"),
  "prose around the chip still renders",
);

// --- 4. activity windows are per-turn: counter, live tail, ctrl+o expand ---
const busyTranscript = [
  { id: 1, role: "user" as const, text: "investigate" },
  { id: 2, role: "assistant" as const, text: "Checking." },
  ...Array.from({ length: 7 }, (_, i) => ({
    id: 3 + i,
    role: "info" as const,
    text: `⚙ tool(${i})`,
  })),
  { id: 10, role: "assistant" as const, text: "Done." },
];
const collapsed = renderChat(busyTranscript, {
  width: 60, busy: false, frame: "⠋", elapsed: 0, modelId: "m",
});
const expandedAll = renderChat(busyTranscript, {
  width: 60, busy: false, frame: "⠋", elapsed: 0, modelId: "m", globalExpanded: true,
});
const collapsedText = collapsed.map((l) => rowText(l)).join("\n");
const expandedText = expandedAll.map((l) => rowText(l)).join("\n");
expect(
  collapsedText.includes("· ⋯ 7 tool uses (ctrl+o to expand)"),
  "finished turn collapses to one counter line",
);
expect(
  !collapsedText.includes("⚙ tool("),
  "finished turn hides all tool lines",
);
const activeView = renderChat(busyTranscript, {
  width: 60, busy: true, frame: "⠋", elapsed: 0, modelId: "m",
});
const activeText = activeView.map((l) => rowText(l)).join("\n");
expect(
  activeText.includes("3 earlier tool lines hidden"),
  "active turn shows the hidden counter",
);
expect(
  activeText.includes("⚙ tool(6)") && !activeText.includes("⚙ tool(2)"),
  "active turn keeps only the last 4 activity rows",
);
expect(
  expandedText.includes("⚙ tool(0)") && expandedText.includes("⚙ tool(6)") && !expandedText.includes("hidden"),
  "expanded run shows every tool line",
);

// --- 5. per-turn expansion: ctrl+o on a selection affects only that turn ---
const twoTurns = [
  { id: 1, role: "user" as const, text: "one" },
  { id: 2, role: "assistant" as const, text: "Working." },
  { id: 3, role: "info" as const, text: "⚙ a()" },
  { id: 4, role: "info" as const, text: "⚙ b()" },
  { id: 5, role: "assistant" as const, text: "Middle done." },
  { id: 6, role: "user" as const, text: "two" },
  { id: 7, role: "assistant" as const, text: "Again." },
  { id: 8, role: "info" as const, text: "⚙ c()" },
  { id: 9, role: "assistant" as const, text: "Finished." },
];
const onlySecond = renderChat(twoTurns, {
  width: 60, busy: false, frame: "⠋", elapsed: 0, modelId: "m",
  expandedTurns: new Set([6]), // turn 2's user entry id
});
const onlySecondText = onlySecond.map((l) => rowText(l)).join("\n");
expect(
  onlySecondText.split("⚙ c()").length - 1 === 1,
  "selected turn expands its tool lines",
);
expect(
  !onlySecondText.includes("⚙ a()") && onlySecondText.includes("· ⋯ 2 tool uses"),
  "unselected turn stays collapsed",
);
const withSelection = renderChat(twoTurns, {
  width: 60, busy: false, frame: "⠋", elapsed: 0, modelId: "m",
  selectedTurnId: 1,
});
const selectedHeader = withSelection.find((l) => l.selected)!;
expect(
  selectedHeader.turnId === 1 && selectedHeader.bgColor === "cyan",
  "selected turn's counter highlights",
);
const counters = withSelection.filter((l) => l.selectable).map((l) => l.turnId!);
expect(
  counters.length === new Set(counters).size && counters.length >= 2,
  "every turn counter is selectable",
);

if (failures > 0) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nPASS");
