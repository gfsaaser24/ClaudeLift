# ClaudeLift MCP server

> Let any MCP-capable agent read and export your **Claude Cowork** chats — right from the chat window.

ClaudeLift ships a standalone [Model Context Protocol](https://modelcontextprotocol.io) server alongside the desktop app. Point Claude Desktop, Claude Code, or Cursor at it and your agent can list every Cowork chat, pull a rendered transcript, build a continuation "seed" prompt, browse your exported bundles, run a real export, and even import a bundle back into your local Cowork data — all without leaving the conversation. Ask *"pull the transcript of my SOP chat"* and the agent does it.

The server runs entirely on your machine. It shells out to ClaudeLift's bundled export engine using the installed app's own Node runtime (Electron-as-node), so there is **nothing extra to install** — if ClaudeLift is installed, the server is already on disk.

> **Where the tools show up:** in regular **Claude Desktop** chats and in **Claude Code** / **Cursor**. They do **not** appear inside Claude **Cowork** (agent-mode) chats — Cowork runs in a remote sandbox with no access to your local processes, so a local (stdio) MCP server can't reach it. Pull your Cowork context from a normal Claude Desktop chat or from Claude Code instead.

---

## Table of contents

- [Why it's useful](#-why-its-useful)
- [Requirements](#-requirements)
- [Tools](#-tools)
- [Install & configure](#-install--configure)
  - [Claude Desktop](#claude-desktop)
  - [Claude Code](#claude-code)
  - [Cursor](#cursor)
  - [Optional: override the engine path](#optional-override-the-engine-path)
- [Try it](#-try-it)
- [Troubleshooting](#-troubleshooting)
- [Security](#-security)

---

## 💡 Why it's useful

Cowork chats are rich — each "task" runs in its own sandbox with uploads, generated files, and a full transcript. But that context is trapped inside Claude Desktop. The MCP server hands it to whichever agent you're already talking to:

- **An agent pulling its own past-chat context.** Start a fresh chat and say *"read the transcript of my onboarding SOP task and keep going from there"* — the agent fetches it and continues the work.
- **Cross-tool recall.** Working in Claude Code or Cursor? Ask it to list your Cowork chats and pull the one you need as reference, without alt-tabbing to Claude Desktop.
- **One-line exports.** *"Export my Q3 planning chat to a bundle"* writes the full portable bundle (transcript + files) to disk, no clicking through the app.

---

## 📋 Requirements

- **ClaudeLift must be installed.** The installer ships the MCP server (`server.cjs`) and the export engine sidecar; there is no separate download. Default per-user install path:
  `%LOCALAPPDATA%\Programs\ClaudeLift\`
- **Windows.** ClaudeLift is a Windows app, and the server runs the bundled `ClaudeLift.exe` as its Node runtime.
- **An MCP client** — Claude Desktop, Claude Code, or Cursor.

You do **not** need Node, Python, or the command line installed. The server borrows the runtime that ships inside ClaudeLift.

---

## 🧰 Tools

Six tools, all prefixed `claudelift_`. Four are read-only; `claudelift_export_task` only ever creates bundle files, and `claudelift_import_bundle` can restore a bundle into your local Cowork data — but it defaults to a **dry run** and never deletes anything.

| Tool | What it does | Key params | Read-only? |
|---|---|---|---|
| **`claudelift_list_tasks`** | Lists Cowork (and/or Claude Code) chats found on this machine — id, title, model, space, last activity, and whether a transcript exists. Start here to find a `task_id`. | `source` `cowork`\|`code`\|`both` (default `cowork`), `cowork_root?`, `response_format` `markdown`\|`json` (default `markdown`) | ✅ Yes |
| **`claudelift_get_transcript`** | Renders one chat's full transcript. | `task_id` (required), `format` `md`\|`json` (default `md`) | ✅ Yes |
| **`claudelift_seed_prompt`** | Builds a paste-able Markdown "seed" prompt that hands a fresh chat the prior task's context (metadata, files, where things left off). | `task_id` (required), `mode` `brief`\|`standard`\|`full` (default `standard`) | ✅ Yes |
| **`claudelift_list_bundles`** | Lists previously exported bundles in a directory — task id, title, export time, size, and which session formats were written. | `output_dir?` (defaults to `Documents/CoworkExports`), `response_format` `markdown`\|`json` (default `markdown`) | ✅ Yes |
| **`claudelift_export_task`** | Runs a real export of a chat into a bundle directory on disk, including uploaded and generated files, plus a manifest and transcript. Returns the bundle path and a manifest summary. | `task_id` (required), `formats[]` any of `html`,`md`,`json`,`csv` (default: all four), `output_dir?` (defaults to `Documents/CoworkExports`) | ✍️ Writes files (non-destructive) |
| **`claudelift_import_bundle`** | Restores an exported bundle back into your local Cowork data as a new chat — rewriting paths for this machine. **Defaults to a dry run** that only prints the plan; call again with `dry_run=false` to actually write. Never deletes or overwrites existing data (use `force` to replace a colliding task id). | `bundle_dir` (required), `dry_run` (default `true`), `workspace?`, `remaps[]` `{from,to}` (for `userSelectedFolders`), `keep_task_id?`, `force?` | ⚠️ Dry-run by default; writes only when `dry_run=false` |

**Notes**

- `claudelift_get_transcript` and `claudelift_seed_prompt` cap their output at **25,000 characters** and truncate with a note when a chat runs longer — export the task to a bundle to read the full content.
- `claudelift_import_bundle` is **dry-run by default**: the first call just prints the plan (target workspace, the new task id it would create, any path remaps). Review it, then call again with `dry_run=false` to write. If the bundle references machine-local folders (`userSelectedFolders`), the engine asks for a `remaps` entry; if more than one Cowork workspace exists, it asks for a `workspace` — pass those and retry.
- Where a param has a default, you can omit it. `task_id` is always the full id returned by `claudelift_list_tasks`.

### Deliberately not exposed

To keep the server safe-by-default, the following stay in the desktop app and are **not** available over MCP: **purge** (deleting the local Cowork copy), **auth-artefact bundling** (`--include-auth`), and **Notion publishing**. The MCP surface reads your chats, writes export bundles, and can import a bundle back (dry-run first) — but it can never delete your Cowork data.

---

## 🔌 Install & configure

### Easiest: the `.mcpb` extension (Claude Desktop)

Download **`ClaudeLift-0.5.0.mcpb`** from the [latest release](https://github.com/gfsaaser24/ClaudeLift/releases/latest) and **double-click it** — or drag it into Claude Desktop, or go to **Settings → Extensions → Advanced → Install Extension**. Claude Desktop runs it with its own bundled Node, so there's nothing else to install. On the extension's config screen, confirm the **engine path** (pre-filled to the standard install location, `%LOCALAPPDATA%\Programs\ClaudeLift\resources\engine\cowork-export\cowork-export.exe`). Requires ClaudeLift to be installed.

> The app's **Settings → MCP server** card also has an **Add to Claude Desktop** button that writes the config for you.

For Claude Code, Cursor, or hand-configuring Claude Desktop, use the manual config below.

### Manual config (Claude Desktop, Claude Code, Cursor)

Each client spawns its own copy of the server over stdio. The config is the same everywhere: run the installed `ClaudeLift.exe` as Node (via `ELECTRON_RUN_AS_NODE=1`) and point it at the bundled `server.cjs`.

> **Replace `<you>`** with your Windows username in every path below. The install directory is `%LOCALAPPDATA%\Programs\ClaudeLift` — for most users that expands to `C:\Users\<you>\AppData\Local\Programs\ClaudeLift`.

The canonical config block:

```json
{
  "mcpServers": {
    "claudelift": {
      "command": "C:\\Users\\<you>\\AppData\\Local\\Programs\\ClaudeLift\\ClaudeLift.exe",
      "args": ["C:\\Users\\<you>\\AppData\\Local\\Programs\\ClaudeLift\\resources\\mcp\\server.cjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

### Claude Desktop

1. Open (or create) `%APPDATA%\Claude\claude_desktop_config.json`.
2. Paste the block above (merge the `claudelift` entry into `mcpServers` if the file already has other servers).
3. **Fully quit and reopen** Claude Desktop — closing the window to the tray is not enough; use *Quit* so the config reloads.

### Claude Code

Add it with one command (fill in your username):

```powershell
claude mcp add claudelift --env ELECTRON_RUN_AS_NODE=1 -- "C:\Users\<you>\AppData\Local\Programs\ClaudeLift\ClaudeLift.exe" "C:\Users\<you>\AppData\Local\Programs\ClaudeLift\resources\mcp\server.cjs"
```

Or add it to a project's `.mcp.json` using the same shape as the canonical block:

```json
{
  "mcpServers": {
    "claudelift": {
      "command": "C:\\Users\\<you>\\AppData\\Local\\Programs\\ClaudeLift\\ClaudeLift.exe",
      "args": ["C:\\Users\\<you>\\AppData\\Local\\Programs\\ClaudeLift\\resources\\mcp\\server.cjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

### Cursor

Create or edit `.cursor/mcp.json` (project-local) or the global `~/.cursor/mcp.json` and use the same `mcpServers` shape as the canonical block above.

### Optional: override the engine path

The server auto-resolves the export engine to `resources/engine/cowork-export/cowork-export.exe` next to `server.cjs`, so a normal install needs no extra config. If your engine sidecar lives elsewhere, set the `CLAUDELIFT_ENGINE_EXE` environment variable to its full path and add it alongside `ELECTRON_RUN_AS_NODE` in the `env` block:

```json
"env": {
  "ELECTRON_RUN_AS_NODE": "1",
  "CLAUDELIFT_ENGINE_EXE": "C:\\path\\to\\cowork-export.exe"
}
```

---

## 🚀 Try it

Once the server is connected, just talk to your agent:

- **List your chats:** *"List my Cowork chats."*
  The agent calls `claudelift_list_tasks` and returns each chat's title, model, space, and short id.
- **Pull a transcript:** *"Get the transcript of my SOP chat."*
  The agent finds the matching `task_id` and calls `claudelift_get_transcript`.
- **Resume a chat:** *"Build a full seed prompt from my onboarding task so I can continue it here."*
  The agent calls `claudelift_seed_prompt` with `mode: full` and hands you back a paste-able prompt.
- **Export to disk:** *"Export my Q3 planning chat to a bundle."*
  The agent calls `claudelift_export_task`; the bundle lands under `Documents\CoworkExports\<task_id>`.
- **Import a bundle back:** *"Import the bundle at `Documents\CoworkExports\<id>` — show me the plan first."*
  The agent calls `claudelift_import_bundle` (dry run), shows you the target workspace and new task id, and only writes once you confirm with `dry_run=false`.

---

## 🩹 Troubleshooting

**"Server not found" / the client fails to start it.**
Double-check the two paths in your config. `command` must point at the real `ClaudeLift.exe` and `args[0]` at `...\resources\mcp\server.cjs`. Confirm ClaudeLift is actually installed under `%LOCALAPPDATA%\Programs\ClaudeLift` (open that folder in Explorer). Remember JSON needs **escaped backslashes** (`\\`) in Windows paths, and that you replaced `<you>` with your username. After editing, fully restart the client (for Claude Desktop, *Quit*, not just close-to-tray).

**The tools appear but `claudelift_list_tasks` returns "No tasks found."**
That means the engine ran but found no Cowork data. Make sure **Claude Desktop is installed and you've actually had at least one Cowork chat**. If your Cowork sessions live in a non-standard location, pass `cowork_root` to `claudelift_list_tasks` (or list `source: "both"` to include legacy Claude Code sessions under `~/.claude`).

**"cowork-export engine not found …"**
The server couldn't locate the sidecar. On a normal install it sits at `resources\engine\cowork-export\cowork-export.exe` next to the server. If you've relocated it, set `CLAUDELIFT_ENGINE_EXE` to its full path in the `env` block (see [above](#optional-override-the-engine-path)).

**A transcript or seed prompt looks cut off.**
That's expected for long chats — output is capped at 25,000 characters and truncated with a note. Use `claudelift_export_task` to write the full transcript and files to a bundle.

---

## 🔒 Security

The MCP server is designed to be **read-first and local-only**:

- **Read-first surface.** Four of the six tools are read-only. `claudelift_export_task` only ever creates bundle files on disk. `claudelift_import_bundle` can write into your local Cowork data, but it **defaults to a dry run** (plan only), never deletes, and never overwrites an existing task unless you explicitly pass `force`. No tool purges your Cowork copy, bundles auth artefacts (`--include-auth`), or publishes to Notion — those higher-risk actions stay in the desktop app on purpose.
- **Local stdio, no network.** Each client spawns its own copy of the server and talks to it over stdin/stdout. Nothing listens on a network port; nothing is exposed to other machines.
- **Treat access like file access to your Cowork data.** Transcripts and exports can contain sensitive chat content, uploaded files, and generated output. Anything that can spawn this server can read those chats — so only add it to MCP clients you trust, exactly as you'd guard read access to the underlying files on disk.
