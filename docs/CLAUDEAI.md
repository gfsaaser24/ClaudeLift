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

If no DevTools window is found (DevTools windows can lose their title after the page navigates), use **Developer → Enable Main Process Debugger** instead and press **Run pull through the debugger**. ClaudeLift then starts the same script in Claude Desktop's claude.ai page over the debugger on `127.0.0.1:9229`: no typing, no clipboard. Turn the debugger off again afterwards (or restart Claude Desktop).

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

## Which kind of account is the target?

Claude accounts now come in two layouts. Check the target before you import.

| | Old layout | New layout |
|---|---|---|
| Projects | Cowork **spaces** in `spaces.json` on this PC, linked to claude.ai projects | Cloud **projects** ("channels"); nothing on this PC but `remote-session-spaces.json` |
| Work inside a project | Cowork **tasks** (local files) | **Threads** that run in the cloud |
| How ClaudeLift fills it | `import-all` (below) | **Rebuild projects in the new account** (Migrate card D, below) |

The Migrate view marks a new-layout target with **new layout — use card D** and blocks the old-style import there unless you tick "Import old-style files anyway". Full details: [NEW-LAYOUT-SPEC.md](NEW-LAYOUT-SPEC.md).

## Rebuilding projects in a new-layout account

Migrate → **Rebuild projects in the new account**:

1. **Make the plan.** Pick the converted account folder (it has `projects\`, `account\`, `conversations\`) and, if you have them, the exported Cowork task bundles. ClaudeLift runs `plan-push` and lists every project with its docs, files, chats, Cowork tasks, memory notes and size. Empty projects are left out. Credentials (API keys, tokens) are removed from memory notes and text files first.
2. **Check the new account.** Either sign in to the new account inside ClaudeLift (sign out first if you pulled the old account there), or use Claude Desktop with **Developer → Enable Main Process Debugger** while it is signed in to the new account. **Check account** shows the email, the organization and the projects already there. This only reads.
3. **Rebuild.** A dry run (on by default) says, per project, create / skip / finish, and writes nothing. Then turn off Dry run and press **Write N projects to <email>**. ClaudeLift stops if the page is signed in to another account.

What lands where, per project:

| Saved | New project |
|---|---|
| Name | Same name. A project whose name is already there is skipped. A Cowork space that has the same name as a claude.ai project becomes "<name> (Cowork)". |
| Instructions | Project instructions (up to 16,000 characters; longer text is cut there and kept in full as `INSTRUCTIONS (full).md` in the Library) |
| Knowledge docs | Library, top level |
| Uploaded files (PDF, XLSX, …) | Library `files/` (files over 150 MB are listed as failed; add them by hand. claude.ai allows up to 500 MB per file) |
| Chats of the project | Library `chats/<date> <title>.md` (threads can read them; old chats cannot become threads) |
| Cowork tasks of the space | Library `cowork/<date> <title>.md` |
| Project memory | Memory notes (`cloud-memory.md` becomes `/project-memory.md`) |
| Account memory | Project "Account memory (imported)" |
| Cowork tasks with no space | Project "Cowork history (imported)" |
| Linked PC folders (option "Linked PC folders") | The folder is recorded on the project (`context_sources: local_folder`) and its files go to the Library under `<folder name>/`, exactly like the Library's **Add folder**. Hidden folders, `node_modules`, caches and Office lock files are left out; credentials are blanked in text files. |
| Chats in no project (optional) | Project "Chat history (imported)" |

File names are cleaned first: garbled characters (for example `â€™` for `’`) are repaired and control characters removed, because claude.ai answers OK for such names but does not store the file. A file counts as written only when claude.ai confirms its exact path.

claude.ai limits each project's Library to 10 GB, 50,000 files and 500 MB per file. If claude.ai asks to slow down (it limits how fast new projects are made), the push waits as long as it asks and goes on.

**Live folder links** (Project settings → environment → Add folder) are a separate thing: they let threads work in the folder on this PC through Claude Desktop. Claude Desktop allows only **6 linked folders per PC**, and each link needs the folder picker, so ClaudeLift does not make them. Link the folders you work in most by hand.

Every run writes a receipt to `<export folder>\push-receipts\` with every project, file and memory id it made. Run it again at any time: finished projects are skipped, and a project ClaudeLift made but did not finish is completed (only the missing files and notes are added). Tick **Also add new files to projects ClaudeLift already made** to add, for example, folder files to projects made in an earlier run. Nothing is ever deleted or replaced.

From the command line, the plan is `python cowork_export.py plan-push --source .\claude-account --cowork-bundles .\account-move --org "My Org" [--local-folders] --out .\push-plans\plan.json`. The write step needs a signed-in claude.ai page, so it runs from the app.

Still by hand on the new account: your profile text (`account/profile.md` → Settings), custom skills and plugins (`account/<org>/custom-skills-upload/`, `plugins-upload/`, see `REINSTALL.md`).

## Importing into an old-layout account

1. Sign in to the other account in Claude Desktop once, so its Cowork folder exists.
2. Quit Claude Desktop (tray icon → Quit).
3. `python cowork_export.py import-all .\claude-account --workspace <...\local-agent-mode-sessions\<acct>\<org>> --dry-run`, then again without `--dry-run`. Or use the Migrate view.
4. Start Claude Desktop.

What lands where:

- Each project becomes a Cowork space with its instructions and memory; its docs and files go to `~\Claude\Projects\<name>` and are attached to the space. Claude Desktop links a new space to a claude.ai project for the signed-in account and uploads its memory (files up to 48,896 bytes, 200 per project).
- Each chat becomes a Cowork task you can continue, filed under its project's space when it had one.
- Account memory becomes the space "Account memory (imported)".
- By hand on the new account: paste `account/profile.md` into Settings, and upload the zips in `custom-skills-upload/` under Customize → Skills.
