# Moving a claude.ai account

ClaudeLift can save everything in a claude.ai account and load it into Cowork on another account. There are two sources, and the best result uses both.

| Source | How you get it | What it has | What it misses |
|---|---|---|---|
| **Data export** | claude.ai → Settings → Privacy → Export data. You get a manifest and `conversations-*`, `projects-*`, `memories-*`, `design_chats-*`, `frames-*` zips. | Every chat with full messages, projects (instructions + text docs), account and project memory, design chats, artifacts. | Uploaded project files (PDF, images, CSV/XLSX), which project a chat belongs to, your profile and personal preferences, skills, other organizations. |
| **Live pull** | `scripts/pull-claude-projects.js`, run in the claude.ai DevTools console (ClaudeLift does this for you, see below). | Projects with **all uploaded files**, sync sources, project memory; your profile (personal preferences, Cowork global instructions); account memory and memory settings; skills list; styles; the chat list with each chat's project — for **every organization** you belong to. With `chats: 'full'`, every chat's messages too. | Nothing the export has that matters, except design chats and artifacts. |

## The live pull

ClaudeLift → **Migrate → Pull your whole claude.ai account** has two routes. Both run the same script in a signed-in claude.ai page.

### Sign in inside ClaudeLift (recommended)

1. Press **Sign in**. A claude.ai window opens inside ClaudeLift. Sign in as usual (if Google sign-in is refused in this window, use the email code option). The window closes when you are signed in.
2. Press **Run pull**. ClaudeLift loads claude.ai in a hidden window, runs the script there, shows its progress lines, and saves `claudelift-pull-<run id>.json` to `<export folder>\claude-account-pulls`. Then it converts it.

The sign-in is stored only in ClaudeLift on this PC (its own browser session, separate from everything else). **Sign out** removes it.

### Claude Desktop's DevTools (fallback)

Claude Desktop refuses to start with a remote-debugging port (`refusing to start — a debugging or network-override switch is present`), and tools that need that port (such as chrome-devtools-mcp) cannot attach to it. Developer Mode is the supported way in.

1. In Claude Desktop: **Help → Troubleshooting → Enable Developer Mode**. A **Developer** menu appears.
2. Choose **Developer → Show All Dev Tools**. Use the window titled `Developer Tools - https://claude.ai/...` and pick its **Console** tab. (**Show Dev Tools**, Ctrl+Alt+I, opens DevTools for whichever part of the window has keyboard focus — usually the app shell, `Developer Tools - file:///…app.asar…`, whose console cannot read your account.)
3. Press **Run pull** on the DevTools route. ClaudeLift finds the claude.ai window, brings it to the front (it checks that the window really is in front and not covered before it types anything), types `allow pasting`, pastes the script, and restores your clipboard. A live picture of the console shows progress. Do not type in that window until it is done.
4. The script saves `claudelift-pull-<run id>.json` to your Downloads folder. ClaudeLift picks it up and converts it.

The script only sends `GET` requests with the session that is already signed in. It never sends your data anywhere but the downloaded file.

You can also run it by hand: paste `scripts/pull-claude-projects.js` into the console (type `allow pasting` first if Chrome asks). It saves `claude-projects-full-<date>.json`.

Endpoints it reads (all under `https://claude.ai`):

| Data | Route |
|---|---|
| Organizations | `/api/organizations` |
| Profile | `/api/account_profile` |
| Projects | `/api/organizations/{org}/projects?include_harmony_projects=true&limit&offset` |
| Project detail, docs, files, syncs | `/api/organizations/{org}/projects/{project}`, plus `/docs`, `/files`, `/syncs`, `/settings` under it |
| Uploaded file bytes (any kind, incl. CSV/XLSX "blob" files) | `/api/organizations/{org}/files/{file}/contents` |
| Memory, memory settings | `/api/organizations/{org}/memory[?project_uuid=]`, `/memory/settings` |
| Skills, styles | `/api/organizations/{org}/skills/list-skills`, `/list_styles` |
| Chats | `/api/organizations/{org}/chat_conversations?limit&offset`, `/chat_conversations/{chat}?tree=True&rendering_mode=messages&render_all_tools=true` |

Organizations without a claude.ai chat surface (API-only Console orgs) answer `403`; the script notes that and moves on.

## Converting

```powershell
python cowork_export.py convert-claudeai "$HOME\Downloads\Claude Download" --pull "$HOME\Downloads\claudelift-pull-<id>.json" -o .\claude-account
```

`--what` picks the parts (default `conversations,projects,memory,account,design`; add `artifacts` for the frames archive). `--pull` is optional: without it, pull files in the export folder (or the newest in Downloads) are used. The export folder is optional when `--pull` is given.

Output:

```
claude-account/
  projects/INDEX.md                              every project, with its org, kind and counts
                                                 kind: knowledge | cowork-space (files live in a local
                                                 folder; README lists it) | instructions-only | empty
  projects/<Project name> (<id>)/
    INSTRUCTIONS.md  README.md  docs/  files/  memory/  sync-sources.json  space.json
  memory/                                        account memory (areas, topics, people, profile, preferences)
  account/profile.md                             personal preferences + Cowork instructions, ready to paste
  account/<Org> (<id>)/
    memory.md  memory-settings.json  skills-list.json  styles.json  chats-index.json
    skills/                                      every skill folder Claude Code synced to this PC
    custom-skills-upload/<skill>.zip             your own skills, ready to upload on the new account
    plugins-upload/<plugin>.zip                  every installed Cowork plugin (yours and marketplace ones),
                                                 standard plugin layout, ready for Customize → Plugins → Upload
    plugins.json                                 name, marketplace, who installed it, API-key-inside flag
    connectors.json                              connectors (remote MCP servers) to reconnect
  account/REINSTALL.md                           checklist: which zip to upload where, which connectors to reconnect
  conversations/<chat id>/                       one importable bundle per chat; project chats carry space/space.json
```

## Importing into the other account

1. Sign in to the other account in Claude Desktop once, so its Cowork folder exists.
2. Quit Claude Desktop (tray icon → Quit).
3. `python cowork_export.py import-all .\claude-account --workspace <...\local-agent-mode-sessions\<acct>\<org>> --dry-run`, then again without `--dry-run`. Or use the Migrate view.
4. Start Claude Desktop.

What lands where:

- Each project becomes a Cowork space with its instructions and memory; its docs and files go to `~\Claude\Projects\<name>` and are attached to the space. Claude Desktop links a new space to a claude.ai project for the signed-in account and uploads its memory (files up to 48,896 bytes, 200 per project).
- Each chat becomes a Cowork task you can continue, filed under its project's space when it had one.
- Account memory becomes the space "Account memory (imported)".
- By hand on the new account: paste `account/profile.md` into Settings, and upload the zips in `custom-skills-upload/` under Customize → Skills.
