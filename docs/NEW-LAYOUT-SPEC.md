# Spec: moving work into a new-layout Claude account

Status: research done and proven on one project (2026-10-03). Build done (section 6, steps 1–6): engine `plan-push`, app push (`app/src/main/project-push.ts`, `desktop-inspector.ts`, `register-push.ts`), Migrate card D, new-layout guard, DevTools fallback. Live runs: see section 9.
Branch `feat/claudeai-account-migration`, PR #1 (gfsaaser24/ClaudeLift).

## 1. Why this exists

ClaudeLift's import (`import-all`, `import-space`) writes Cowork task files and
`spaces.json` into the target account's local folder. That is right for the
**old layout** (Cowork tasks + local spaces). A newly created account uses the
**new layout**, where projects and threads live in the cloud. Writing local
spaces there does not create projects. The new account must be filled through
the claude.ai API instead, the same calls the Claude Desktop app makes.

## 2. Where things stand

| Item | State |
|---|---|
| Source | An old-layout account (Cowork spaces + tasks) with classic claude.ai projects, saved with the live pull + data export and converted by `convert-claudeai` (projects, chats with their project links, account memory, skills, plugin zips), plus Cowork task bundles from `export`. |
| Target | A new-layout account. Its Cowork folder `…\local-agent-mode-sessions\<account>\<org>` holds only `rpm/`, `scheduled-tasks.json` and `remote-session-spaces.json`. A folder `<old account>\<new org>` can appear while switching accounts; it is not a target. |
| Proven in a target | One project rebuilt by hand with the reference script: instructions, 7 docs at Library top level, 153 chat transcripts in `chats/`, 4 memory notes. A real thread read the docs, chats and memory and wrote new memory. |
| Security | Old project memory and chats can hold API keys. ClaudeLift blanks credentials before writing memory and in text files before upload (the memory store rejects them anyway). Rotate any key you find in old data. |
| Reference scripts | `research/new-layout/` — `cdp-main.mjs`, `inpage.py`, `push_project.py` (proven flow, dry run, skip-by-name, key blanking, padded ids, batch retry), `install-recorder.main.js`, `dump-recorder.main.js`. |

## 3. The new layout (observed live, Claude Desktop 2.19675.0.0)

- **Project = channel** `chan_…`, web link `https://claude.ai/code/project/<chan>` (Claude Desktop's internal route is `claude.ai/epitaxy/project/<chan>`). Each has an agent `cagt_…`, an overview session `cse_…`, a memory store `memstore_…`, a Library (file storage) and a config.
- **Thread = channel message** `cmsg_…` bound to a cloud session (`/v1/code/sessions/session_…`; `cse_…` and `session_…` share the id body). Threads run in the cloud. A local folder is only a live link through Claude Desktop ("remote control"), stored in `%APPDATA%\Claude\remote-control-state.json` (per `org:account` identity) and `<acct>\<org>\remote-session-spaces.json`; project folders added in settings → env become machine environments (`/v1/code/channels/{id}/remote-control-preapproval`).
- **Old chats cannot become real threads.** They go into the project Library as transcripts; a thread reads them from `/mnt/project-files/`.
- **Classic claude.ai projects** (`/api/organizations/{org}/projects`) are empty in the new account; new projects are not classic projects.

### 3.1 API (all same-origin on `https://claude.ai`, cookie session)

Headers for `/v1/code/*`: `content-type: application/json`, `anthropic-version: 2023-06-01`, `anthropic-beta: ccr-byoc-2025-07-29`, `x-organization-uuid: <org>`. Uploads (`/api/{org}/upload`) need no extra headers.

| Purpose | Call | Body / notes |
|---|---|---|
| List projects | `GET /v1/code/channels?scope=all` | `scope` required: `all`, `joined` or `space`. App uses `scope=joined&include_members=true&include_archived=true&limit=200`. Response `{data:[channel]}`. |
| Get project | `GET /v1/code/channels/{chan}` | `{channel:{id,name,agent_id,context_sources,memory_enabled,default_skill_ids,default_plugin_ids,…}}` |
| Create project | `POST /v1/code/channels` | `{name, visibility:"private", context_sources:[], icon?, color?}`. App adds `context_sources:[{kind:"local_folder", name}]` when a folder is picked (files then live under `<name>/` in the Library). |
| Instructions | `PATCH /v1/code/channels/{chan}/config` | `{system_prompt_addendum:"…"}`, UI limit 16,000 chars. Config also holds `default_skill_ids`, `default_plugin_ids`, `default_source_urls`, `mcp_servers`, `memory_enabled`, `default_model`. |
| Upload a Library file (use this) | `POST /v1/code/channels/{chan}/files:beginUpload` → `POST /v1/filestore/fs/createFile` | `beginUpload {size_bytes}` → `{filestore_jwt, upload_path, filesystem_id, max_bytes: 503316480, expires_at (+10 min)}`. Then multipart `params` (JSON blob `{filesystem_id, path: upload_path, media_type}`) + `file`, header `authorization: Bearer <filestore_jwt>` (+ `x-organization-uuid`). Then `files:write {files:[{staged_upload_path: upload_path, path}]}`. Up to 480 MB per file; not counted against the chat upload limit. |
| Chat attachment upload (do NOT use for the Library) | `POST /api/{org}/upload?store_as_is=true` | multipart `file` → `{file_uuid}`; `files:write` also accepts `source_file_id` (`file_01…`). Refuses > ~30 MB (413) and stops after ~20,000 files a day (429 `file_limit_exceeded`). |
| File id for Library | — | `file_01` + base58(16 uuid bytes), alphabet `123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz`, **left-padded with `1` to 22 chars**. Same scheme as `user_01…` for accounts. |
| Put files in Library | `POST /v1/code/channels/{chan}/files:write` | `{files:[{path, source_file_id}]}`. Batches of 25 work; one bad id rejects the whole batch (retry one by one). A path that already exists comes back without `entry`. |
| List Library | `POST /v1/code/channels/{chan}/files:list` | `{recursive:true, limit:500}`; **limit must be 1–500** (501 → 400 "Request validation failed"); `cursor` in the response for more. Also `GET …/files/usage`. |
| Memory list / read | `GET /v1/code/memory/channel/{chan}/memories`, `GET …/memories/{mem_id}` | entries `{id:"mem_…", path:"/MEMORY.md", size_bytes, content_sha256}`; single read includes `content`. |
| Memory write | `POST /v1/code/memory/channel/{chan}/memories` | `{path:"/note.md", content, precondition:{type:"not_exists"}}` (browser writes need a precondition; DELETE needs `expected_content_sha256`). 16 KB note accepted. **Content containing credentials is rejected** (`invalid_request_error`) — blank keys first. The UI's own "add memory" instead posts a message asking the agent to edit `MEMORY.md`. |
| New thread | `POST /v1/code/channels/{chan}/messages` | `{body, client_message_id:<uuid>, attachments?:[{file_id:"file_01…", filename, mime_type}]}` → `{message_id, thread_root_id}` |
| Threads / timeline | `GET …/threads`, `GET …/timeline?limit=200[&thread_roots_only=true]` | |
| Session events | `GET /v1/code/sessions/session_…/events?limit=500&sort_order=asc` | shows tool calls (e.g. reads of `/mnt/project-files/…`). |
| Project folder (Library "Add folder") | `PATCH /v1/code/channels/{chan}` | `{context_sources:[{kind:"local_folder", name}]}` (send the full list; existing entries come back with `path:""`, `url:""`), then upload each file and `files:write` it at `<name>/<rel>`. |
| Live folder link (settings → environment → Add folder) | `POST /v1/code/channels/{chan}/remote-control-preapproval` | `{enabled:true, environment_id, folder_path}`. The `environment_id` comes from Claude Desktop itself: `RemoteControlServing.requestAddFolder()` opens a folder picker, registers the folder (`POST /v1/environments/bridge` with device keys) and stores it in `remote-control-state.json` per `org:account`. **At most 6 folders per PC** (`remoteControlServeStatusStore.getState()` → `limit: 6`). `GET …/remote-control-preapproval` lists the PC's environments. |
| Library limits | `GET /v1/code/channels/{chan}/files/usage` | `limit_bytes` 10 GB, `limit_files` 50,000, `limit_file_bytes` 500 MB per project. |
| Seen, not yet used | `GET /v1/code/project-templates` (`{templates:[]}`), `/v1/code/project-conversions/{id}` (a convert-classic-project feature exists; create call not observed). |

## 4. How ClaudeLift can reach the signed-in claude.ai page

1. **Claude Desktop Main Process Debugger (proven, most direct).** Developer menu → *Enable Main Process Debugger* opens a Node inspector on `127.0.0.1:9229`. Over the inspector (`/json/list` → `webSocketDebuggerUrl`, `Runtime.evaluate`), main-process code gets `require('electron').webContents.getAllWebContents()`, picks the `window` whose URL starts with `https://claude.ai`, and calls `executeJavaScript(js, true)` — results come back directly. No typing, no clipboard, no window titles. See `research/new-layout/cdp-main.mjs` + `inpage.py`. (`--remote-debugging-port` on the command line is refused by the app; this menu item is the supported way.)
2. **ClaudeLift's own sign-in session** (`persist:claudeai`, already built: `app/src/main/claudeai-session.ts`). Same calls from a hidden claude.ai window via `executeJavaScript`. Needs no Claude Desktop at all; currently signed in as the *source* account — the user must sign out and in as the target. Preferred for the product (works for any user, no debug features).
3. DevTools console typing (fallback, built). Known bug: DevTools windows can have **blank titles** (seen after the page navigated), so title-based detection fails.

## 5. Mapping old → new

| Old | New |
|---|---|
| claude.ai project (classic) / Cowork space | Channel (project) with the same name; skip if a live channel with that name exists |
| `prompt_template` | `config.system_prompt_addendum`; if > 16,000 chars keep the start there and the full text as `INSTRUCTIONS (full).md` in the Library |
| Project docs (`docs/`) | Library top level |
| Uploaded files (`files/`, incl. PDF/XLSX/CSV) | Library `files/` |
| Project memory notes (`memory/*.md`) | Memory store notes (`/name.md`), keys blanked; skip `cloud-memory.json` (duplicate), rename `cloud-memory.md` → `/project-memory.md` |
| Chats linked to the project (`chats-index.json` `project_uuid`) | Library `chats/<YYYY-MM-DD> <title>.md` (rendered `session.md`) |
| Cowork tasks (94, `account-move\`) | Library `cowork/<YYYY-MM-DD> <title>.md` of the project their space became (space `migration.projectUuid` → old project uuid → new channel by name); tasks with no space → project "Cowork history (imported)" |
| Chats in no project (≈1,200) | Optional project "Chat history (imported)", Library `chats/` |
| Account memory (export `memory/`, `account\<org>\memory.md`) | Project "Account memory (imported)" with those notes in its memory store |
| Plugins, custom skills, connectors | Not automated yet: `account\…\plugins-upload\*.zip`, `custom-skills-upload\*.zip`, `REINSTALL.md` (manual). Channel config has `default_skill_ids` / `default_plugin_ids` once they exist in the new account. |
| Profile (personal preferences, Cowork instructions) | Manual paste from `account\profile.md` |

## 6. Build plan

1. **Engine: `plan-push` command** (`cowork_export.py` + `claudeai_export.py`). Input: a converted folder (`claude-account\…`), optional `--cowork-bundles <account-move>`, `--include-chats`, `--include-unfiled-chats`, `--projects <names|all>`. Output: one JSON plan per project (name, instructions, Library entries with source file paths — not inlined bytes, memory notes already key-blanked, warnings like "instructions truncated", "N keys removed"). Move the key-blanking regex into a shared helper; reuse it for space memory on the old-layout import too. Self-test in `tests/claudeai_selftest.py` (plan shape, truncation, key blanking, chat mapping, Cowork-task mapping).
2. **App: `app/src/main/project-push.ts`.** Executes a plan against a claude.ai page through an executor interface `{ runInPage(js): Promise<unknown> }` with two implementations: the `persist:claudeai` hidden window (default) and the Claude Desktop main-process inspector (optional, detected on `127.0.0.1:9229`). Per project: list channels (skip by name), create, PATCH config, upload each file streaming from disk (one `executeJavaScript` per file or small group — never one giant payload), `files:write` in batches of 25 with per-file retry, memory writes, read-back verify (`files:list` limit 500 with cursor, memory list). Emit progress events; write a receipt JSON (`<outputDir>\push-receipts\<timestamp>.json`) with every created id, so a run can be resumed and audited. Never delete anything.
3. **App UI: Migrate card D "Rebuild projects in the new account".** Shows which account the session is signed in to (email from `/api/account_profile` or the bootstrap), the project list from the plan with kind/size/chat count and checkboxes, options (include chats, include Cowork history, include unfiled chats, dry run on by default), per-project progress, results table, link to open each new project (`https://claude.ai/code/project/<chan>`).
4. **Guard the old-layout import.** Detect a new-layout target (no `spaces.json`, account created after the change — simplest: ask, or detect channels via the API) and steer the user to card D instead of writing `spaces.json`.
5. **DevTools route fix:** when no titled claude.ai DevTools window exists, offer the main-process-debugger route instead of failing.
6. Docs: update `docs/CLAUDEAI.md` and README; tests for every new helper; keep all existing tests green.

### 6.1 As built

- Engine: `cowork_export.py plan-push --source <converted> [--cowork-bundles DIR] [--no-chats] [--include-unfiled-chats] [--no-account-memory] [--org NAME …] [--projects all|"A,B"] [--include-empty] --out plan.json`. One shared `blank_secrets()` (also used by the old-layout space-memory import). Text files with a credential get a blanked copy in `<plan dir>\push-staging\`. Cowork tasks map to the project whose `_pull…cowork_bound_device.local_space_id` matches the bundle's `source_space_id` (fallback: same name). A Cowork space whose name collides becomes "<name> (Cowork)".
- App: plans live in `<outputDir>\push-plans\` (push:run reads only from there); receipts in `<outputDir>\push-receipts\` (`dry-run-*.json`, `push-*.json`). Resume = a live channel with the plan's name whose id a non-dry-run receipt recorded for that key and marked incomplete; only missing Library paths are added (case-insensitive), instructions are set only when empty, memory uses `not_exists`.
- Executors: `persist:claudeai` hidden window (`openPushPage`), Claude Desktop main process (`openDesktopExecutor`; only a loopback inspector whose `process.execPath` is `claude.exe`, never ClaudeLift itself).
- Guard: `WorkspaceInfo.newLayout` = no `spaces.json`, no tasks, `remote-session-spaces.json` present.

## 7. Rules that must hold

- Dry run first, then the real run. Skip projects whose name already exists (never duplicate a project). Never delete or overwrite (memory precondition `not_exists`).
- Blank credentials before any upload to memory; report how many were removed (never print the key).
- `files:list` limit ≤ 500; tagged ids padded to 22 chars; batch failure → per-file retry.
- Only GET calls until the user approves a write run. Writes go only to the account the user picked; show its email before writing.
- The new layout needs no Claude Desktop restart; nothing is written to the local Cowork folder.

### 7.1 Limits and traps found in the real run (2026-10-03, 65 projects, ~33,000 files)

- `POST /v1/code/channels` answers **429 "Too many projects created. Retry in Ns."** after about a dozen creates in a row; waiting the asked time works.
- The chat upload `POST /api/{org}/upload` answers **413 "Uploaded file too large"** above about 30 MB. The Library's own upload (`files:beginUpload` + filestore `createFile`, recorded 2026-10-03) takes up to 480 MB; ClaudeLift now uses it.
- The chat upload also answers **429 "Exceeded file limits"** (`file_limit_exceeded`) after about **20,000 uploads in one day** (still on 10 hours later). The Library upload kept working during that limit.
- `files:write` answers **200 but drops** paths with control characters, garbled UTF-8 (`â\x80\x99`) or invisible characters (U+FE0F); the dropped path is missing from `results`. Clean names first; count a file only when `results` confirms its path.
- `GET …/memories` returns 20 notes by default; ask `?limit=100`.

## 8. Open questions

- Plugin and skill upload calls (record them with the recorder while the user uploads one zip in Customize → Plugins / Skills).
- Whether `/v1/code/project-conversions` can convert a classic project server-side (would replace parts of step 2).
- Account-level memory location in the new layout (the "Account memory (imported)" project is the fallback).
- 3 PNG files in one project were dropped by `files:write` with plain names; cause unknown.

## 9. Acceptance

- Dry run lists all chosen projects with correct counts and "skip" for existing names.
- Real run for 3 sample projects (one docs-only, one with PDFs, one former Cowork space): each opens in Claude Desktop with instructions, Library, memory; a new thread can read a Library file and a memory note.
- Receipt JSON lists every created channel/file/memory id; re-running skips everything already done.
- `npm run typecheck`, `npm test`, both engine self-tests pass; PR updated.
