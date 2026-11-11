/**
 * Middleware tools smoke test — shell, notes (temp/session), git helpers,
 * exercised for real inside a temp project. No API key needed.
 *
 * Run: bun run test/tools-middleware.ts
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../core/middleware/tools/registry";
import { registerFileTools } from "../core/middleware/tools/files";
import { registerShellTool } from "../core/middleware/tools/shell";
import { registerNoteTools } from "../core/middleware/tools/notes";
import { NoteStore } from "../core/middleware/tools/notes/store";
import { registerGitTools } from "../core/middleware/tools/git";

const root = mkdtempSync(join(tmpdir(), "halo-mw-"));
// turn the temp dir into a git repo with an identity
const setup = (args: string[]) => {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root });
  return proc.stdout.toString() + proc.stderr.toString();
};
setup(["init", "-q"]);
setup(["config", "user.email", "test@test"]);
setup(["config", "user.name", "test"]);

const registry = new ToolRegistry();
registerFileTools(registry, root);
registerShellTool(registry, root);
registerGitTools(registry, root);

const notes = new NoteStore();
registerNoteTools(registry, notes);

let failures = 0;
async function check(
  label: string,
  actual: string,
  expectedIncludes: string[],
): Promise<void> {
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

// ---- shell ----
await check("shell runs a command", await run("shell_run", { command: "echo halo-shell" }), [
  "exit 0",
  "halo-shell",
]);
await check(
  "shell refuses destructive command",
  await run("shell_run", { command: "sudo rm -rf /" }),
  ["refusing"],
);
await check(
  "shell rejects escaping cwd",
  await run("shell_run", { command: "pwd", cwd: "../elsewhere" }),
  ["error", "escapes"],
);
await check(
  "shell reports failing exit code",
  await run("shell_run", { command: "exit 3" }),
  ["exit 3"],
);

// ---- notes ----
await check("note_add (session)", await run("note_add", { title: "plan", text: "fix parser" }), [
  "note #1 saved (session)",
]);
await check("note_add (temp)", await run("note_add", { title: "scratch", text: "tmp", scope: "temp" }), [
  "note #2 saved (temp)",
]);
await check("note_list shows both", await run("note_list", {}), ["#1 [session] plan", "#2 [temp] scratch"]);
await check("note_update", await run("note_update", { id: 1, text: "fix parser + tests" }), ["updated"]);
await check("note_get", await run("note_get", { id: 1 }), ["fix parser + tests"]);
await check("note_delete", await run("note_delete", { id: 2 }), ["deleted"]);
notes.clearTemp(); // turn boundary: temp notes die, session notes survive
if (notes.list().length !== 1 || notes.list()[0]!.id !== 1) {
  console.error("FAIL: clearTemp should leave only the session note");
  failures++;
} else {
  console.log("ok  clearTemp drops temp, keeps session");
}

// ---- git ----
writeFileSync(join(root, "tracked.txt"), "one\n");
await check("git_status shows untracked file", await run("git_status", {}), ["??", "tracked.txt"]);
await check(
  "git_commit stages and commits",
  await run("git_commit", { message: "first commit", addAll: true }),
  ["first commit"],
);
await check("git_log shows the commit", await run("git_log", {}), ["first commit"]);
writeFileSync(join(root, "tracked.txt"), "one\ntwo\n");
await check("git_diff shows changes", await run("git_diff", {}), ["+two"]);
await check("git_commit requires message", await run("git_commit", { message: " " }), ["error"]);

rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.error(`\n${failures} FAILURES`);
  process.exit(1);
}
console.log("\nPASS");
