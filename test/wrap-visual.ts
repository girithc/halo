import { renderChat } from "/Users/girithc/Documents/halo/interface/cli/terminal";
const out = renderChat(
  [
    {
      id: 1,
      role: "assistant",
      text: "`ToolRegistry` lives in:\n\n```\nexport class ToolRegistry {\n  register(tool: Tool): void\n  get(name: string): Tool | undefined\n}\n```",
    },
  ],
  { width: 60, busy: false, frame: "⠋", elapsed: 0, modelId: "m" },
);
console.log(out.map((l) => `${l.bgColor ? "[panel]" : "      "}${l.text}`).join("\n"));
