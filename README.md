# halo

A terminal coding agent. Type `halo`, ask questions about your codebase, and it answers with full tool access — file search, reads, edits, shell commands, git.

Built on [Bun](https://bun.sh) + [Ink](https://github.com/vadimdemedes/ink). Works with any OpenAI-compatible API (DeepSeek, OpenAI, OpenRouter, Groq, local Ollama) and Meta's Responses API.

## Requirements

- [Bun](https://bun.sh) v1.2+
- An API key from at least one provider

## Install

```bash
bun install
bun link        # makes `halo` available globally
```

If `halo` isn't on your PATH after `bun link`:

```bash
ln -s "$(pwd)/interface/cli/halo.ts" ~/.bun/bin/halo
```

## Usage

```bash
halo                # interactive session
halo "prompt"       # one-shot answer, streamed to stdout
```

First run starts a setup wizard: pick a provider, paste an API key, pick a model. Choices persist to `~/.halo/`.

### Session keys

| Key | Action |
|---|---|
| `Enter` | send message |
| `Esc` | interrupt the current reply |
| `Ctrl-C` | interrupt, or quit when idle |
| `PageUp` / `PageDown` | scroll transcript |
| `Up` / `Down` | scroll one line |
| `Home` / `End` | oldest line / back to live |
| `Tab` / `Shift-Tab` | cycle selection over tool-activity windows |
| `Ctrl-O` | expand/collapse the selected turn's tool activity (all turns if none selected) |

### Commands

| Command | Action |
|---|---|
| `/model <id\|preset>` | switch model for the session |
| `/config` | persist current model setup |
| `/clear` | reset conversation history |
| `/help` | help |
| `/quit` | exit |

Presets: `deepseek`, `meta`, `openai`, `openrouter`, `groq`, `ollama`.

## Configuration

| File | Purpose |
|---|---|
| `~/.halo/.env` | API keys (`META_API_KEY`, `DEEPSEEK_API_KEY`, …), created by onboarding |
| `~/.halo/config.json` | default provider/model (`provider`, `model`, `baseURL`, `api`, `reasoningEffort`) |
| `.env` (project) | optional per-project overrides — Bun loads it automatically |

Environment overrides beat config files: `HALO_API_KEY`, `HALO_BASE_URL`, `HALO_MODEL`, `HALO_API` (`chat-completions` or `responses`).

Debug a provider stream:

```bash
HALO_DEBUG=1 halo     # echoes raw SSE lines to stderr
HALO_KEYDEBUG=1 halo  # echoes raw keystrokes to stderr
```

## Tools

The agent can act, not just chat. Registered tools:

- `file_search`, `file_read`, `file_create`, `file_edit` — project-file operations, rooted to the working directory
- `shell_run` — shell commands (timeout, output truncation, destructive-command guard)
- `git_status`, `git_diff`, `git_log`, `git_commit` — local git state
- `note_add/list/get/update/delete` — agent scratch memory; notes are per-turn (`temp`) or per-session (`session`)

Tool calls stream into the transcript; each turn's activity collapses to one line (`Ctrl-O` to expand). A tool budget (10 rounds) caps runaway loops, after which the model must answer from what it gathered.

## Architecture

```
core/
├── in/          # input parsing, context gathering
├── out/         # the agent loop: model call → tool calls → results → answer
└── middleware/
    ├── tools/   # tool registry + implementations (files, shell, git, notes)
    ├── mcp/     # Model Context Protocol client (interface)
    └── context/ # message-list assembly/trimming
models/          # provider contracts + OpenAI-compatible / Meta Responses clients
secrets/         # key resolution and storage (~/.halo)
interface/cli/   # Ink TUI, onboarding wizard, one-shot mode
```

`AgentSession` (core/agent.ts) owns chat state and notifies subscribers; the TUI is a pure renderer of it.

## Development

```bash
bun run typecheck   # tsc --noEmit
bun run test        # streaming/tool smoke tests (no API key needed)
bun run test/ui-smoke.ts
bun run test/tool-loop.ts
bun run test/session-loop.ts
bun run test/tools-files.ts
bun run test/tools-middleware.ts
bun run test/tool-budget.ts
bun run dev         # run the CLI directly
```

## License

MIT
