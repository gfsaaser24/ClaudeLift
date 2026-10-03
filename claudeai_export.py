"""Convert a claude.ai data export into ClaudeLift bundles.

claude.ai's "Export data" produces a manifest plus zip parts:

    conversations-NNN.zip  conversations.json   [{uuid, name, summary, created_at,
                                                  updated_at, account, chat_messages:[...]}]
    projects-NNN.zip       projects/<uuid>.json {uuid, name, description, prompt_template,
                                                  docs:[{uuid, filename, content}], ...}
    memories-NNN.zip       memories/<acct>.json {conversations_memory, project_memories,
                                                  memory_files:[{path, content, updated_at}]}
    design_chats-NNN.zip   design_chats/<uuid>.json
    frames-NNN.zip         artifacts/<id>/{artifact.json, versions/*.html}
    light_metadata-NNN.zip users.json, login_history.json

Cowork (Claude Desktop) keeps chats as local tasks in Claude Code's JSONL
transcript format, and since the "spaces → projects" migration every Cowork
space is backed by a claude.ai project whose memory lives under
``/projects/<project-uuid>/`` in the account's memory store. This module maps
the export onto that layout:

    <out>/conversations/<uuid>/   one ClaudeLift bundle per chat (importable as a Cowork task)
    <out>/projects/<uuid>/        space.json + docs/ + memory/  (importable as a Cowork space)
    <out>/memory/                 account-level memory files (areas/, topics/, people/, ...)
    <out>/design_chats/, <out>/artifacts/   copied through for reference

Transcripts are written as plain user/assistant text turns. claude.ai tool
calls carry no ids in the export (``id: null``) and thinking signatures are
bound to the original request, so replaying them verbatim would make a resumed
session fail; they are folded into readable text instead.
"""
from __future__ import annotations

import json
import re
import shutil
import sys
import uuid as uuid_mod
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

DEFAULT_MODEL = "claude-opus-5"
CC_VERSION = "2.1.197"
TOOL_INPUT_TRUNCATE = 1500
TOOL_RESULT_TRUNCATE = 4000
# Tools whose input *is* the work product (artifact / file bodies): keep in full.
FULL_INPUT_TOOLS = {"artifacts", "create_file", "str_replace", "str_replace_based_edit_tool", "repl"}
_SAFE_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


# ---------------------------------------------------------------------------
# Reading the export (zips or already-extracted folders)
# ---------------------------------------------------------------------------

@dataclass
class ClaudeAiExport:
    conversations: list[dict[str, Any]] = field(default_factory=list)
    projects: list[dict[str, Any]] = field(default_factory=list)
    memories: list[dict[str, Any]] = field(default_factory=list)
    design_chats: list[dict[str, Any]] = field(default_factory=list)
    users: list[dict[str, Any]] = field(default_factory=list)
    artifact_sources: list[tuple[Path, str]] = field(default_factory=list)  # (zip or dir, prefix)


def _iter_sources(root: Path) -> Iterator[tuple[str, Any]]:
    """Yield (relative_name, opener) for every file in every export zip/folder
    under ``root``. ``opener()`` returns bytes."""
    if root.is_file() and root.suffix.lower() == ".zip":
        zips = [root]
        dirs: list[Path] = []
    else:
        zips = sorted(root.glob("*.zip"))
        # Zips present: they are the source of truth (an extracted copy next
        # to them would only be read twice).
        dirs = [] if zips else [root]
    for z in zips:
        with zipfile.ZipFile(z) as zf:
            for info in zf.infolist():
                if info.is_dir():
                    continue
                yield info.filename.replace("\\", "/"), (lambda zf_path=z, n=info.filename: _read_zip(zf_path, n))
    for d in dirs:
        for p in d.rglob("*.json"):
            rel = p.relative_to(d).as_posix()
            yield rel, (lambda p=p: p.read_bytes())


def _read_zip(zpath: Path, name: str) -> bytes:
    with zipfile.ZipFile(zpath) as zf:
        return zf.read(name)


def load_export(root: Path) -> ClaudeAiExport:
    root = root.expanduser().resolve()
    if not root.exists():
        raise SystemExit(f"error: export path does not exist: {root}")
    ex = ClaudeAiExport()
    seen: set[str] = set()
    for rel, opener in _iter_sources(root):
        base = rel.rsplit("/", 1)[-1]
        top = rel.split("/")
        try:
            if base == "conversations.json":
                data = json.loads(opener())
                for c in data if isinstance(data, list) else []:
                    if isinstance(c, dict) and c.get("uuid") and ("c:" + c["uuid"]) not in seen:
                        seen.add("c:" + c["uuid"])
                        ex.conversations.append(c)
            elif "projects" in top[:-1] and base.endswith(".json"):
                p = json.loads(opener())
                if isinstance(p, dict) and p.get("uuid") and ("p:" + p["uuid"]) not in seen:
                    seen.add("p:" + p["uuid"])
                    ex.projects.append(p)
            elif "memories" in top[:-1] and base.endswith(".json"):
                m = json.loads(opener())
                if isinstance(m, dict) and ("m:" + str(m.get("account_uuid"))) not in seen:
                    seen.add("m:" + str(m.get("account_uuid")))
                    ex.memories.append(m)
            elif "design_chats" in top[:-1] and base.endswith(".json"):
                d = json.loads(opener())
                if isinstance(d, dict) and ("d:" + str(d.get("uuid"))) not in seen:
                    seen.add("d:" + str(d.get("uuid")))
                    ex.design_chats.append(d)
            elif base == "users.json":
                u = json.loads(opener())
                if isinstance(u, list):
                    ex.users.extend(x for x in u if isinstance(x, dict))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            print(f"  warn: could not parse {rel}: {e}", file=sys.stderr)
    # Artifacts (frames) are large; remember where they are and copy lazily.
    if root.is_dir():
        for z in sorted(root.glob("frames-*.zip")):
            ex.artifact_sources.append((z, "artifacts/"))
        for d in [] if ex.artifact_sources else sorted(root.rglob("artifacts")):
            if d.is_dir() and any(d.glob("*/artifact.json")):
                ex.artifact_sources.append((d, ""))
    ex.conversations.sort(key=lambda c: c.get("updated_at") or c.get("created_at") or "", reverse=True)
    return ex


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _iso_to_ms(ts: str | None) -> int:
    if not ts:
        return 0
    try:
        return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return 0


def _iso_z(ts: str | None) -> str:
    ms = _iso_to_ms(ts)
    if not ms:
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _safe_filename(name: str, fallback: str) -> str:
    name = _SAFE_NAME.sub("_", (name or "").strip()).strip(". ")
    return (name or fallback)[:150]


def _truncate(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n… [truncated {len(text) - limit} chars]"


def _tool_result_text(block: dict[str, Any]) -> str:
    inner = block.get("content")
    if isinstance(inner, str):
        return inner
    parts: list[str] = []
    if isinstance(inner, list):
        for x in inner:
            if not isinstance(x, dict):
                continue
            if x.get("type") == "text":
                parts.append(x.get("text") or "")
            elif x.get("type") == "knowledge":
                title = x.get("title") or ""
                url = x.get("url") or ""
                parts.append(f"- {title} {url}".rstrip())
            elif x.get("type") == "image":
                parts.append("[image]")
    return "\n".join(p for p in parts if p)


def _message_text(msg: dict[str, Any]) -> str:
    """Render one claude.ai chat message as plain text for a replayable turn."""
    content = msg.get("content")
    if not isinstance(content, list) or not content:
        return msg.get("text") or ""
    out: list[str] = []
    for b in content:
        if not isinstance(b, dict):
            continue
        t = b.get("type")
        if t == "text":
            if b.get("text"):
                out.append(b["text"])
        elif t == "tool_use":
            name = b.get("name") or "tool"
            inp = b.get("input")
            if name in FULL_INPUT_TOOLS and isinstance(inp, dict):
                body = inp.get("content") or inp.get("file_text") or inp.get("new_str") or inp.get("code")
                head = {k: v for k, v in inp.items() if k not in ("content", "file_text", "new_str", "code")}
                block = f"[Tool call: {name}] {json.dumps(head, ensure_ascii=False)}"
                if isinstance(body, str) and body:
                    block += f"\n\n{body}"
                out.append(block)
            else:
                rendered = json.dumps(inp, ensure_ascii=False) if inp is not None else ""
                out.append(f"[Tool call: {name}] {_truncate(rendered, TOOL_INPUT_TRUNCATE)}")
        elif t == "tool_result":
            name = b.get("name") or "tool"
            text = _tool_result_text(b)
            label = "Tool error" if b.get("is_error") else "Tool result"
            out.append(f"[{label}: {name}]\n{_truncate(text, TOOL_RESULT_TRUNCATE)}" if text else f"[{label}: {name}]")
        elif t == "document":
            out.append(f"[Attached document: {b.get('title') or b.get('file_uuid') or ''}]")
        elif t == "image":
            out.append("[Attached image]")
        # thinking / token_budget / injected_prompt_block are not replayed
    for a in msg.get("attachments") or []:
        if not isinstance(a, dict):
            continue
        name = a.get("file_name") or "attachment"
        extracted = a.get("extracted_content") or ""
        out.append(f"[Attachment: {name}]" + (f"\n{_truncate(extracted, TOOL_RESULT_TRUNCATE)}" if extracted else ""))
    for f in msg.get("files") or []:
        if isinstance(f, dict):
            out.append(f"[File: {f.get('file_name') or f.get('file_uuid') or ''}]")
    return "\n\n".join(x for x in out if x).strip()


# ---------------------------------------------------------------------------
# Conversations → ClaudeLift bundles
# ---------------------------------------------------------------------------

def conversation_records(conv: dict[str, Any], cli_session_id: str, model: str) -> list[dict[str, Any]]:
    """Claude Code JSONL records for one chat: strictly alternating user /
    assistant text turns (consecutive same-role messages are merged)."""
    turns: list[tuple[str, str, str]] = []  # (role, text, timestamp)
    for m in conv.get("chat_messages") or []:
        if not isinstance(m, dict):
            continue
        role = "user" if m.get("sender") == "human" else "assistant"
        text = _message_text(m)
        if not text:
            continue
        ts = _iso_z(m.get("created_at"))
        if turns and turns[-1][0] == role:
            prev = turns[-1]
            turns[-1] = (role, prev[1] + "\n\n" + text, prev[2])
        else:
            turns.append((role, text, ts))
    if turns and turns[0][0] == "assistant":
        turns.insert(0, ("user", "(conversation continued)", turns[0][2]))

    records: list[dict[str, Any]] = []
    parent: str | None = None
    common = {
        "isSidechain": False,
        "userType": "external",
        "entrypoint": "claudelift-import",
        "cwd": "",
        "sessionId": cli_session_id,
        "version": CC_VERSION,
    }
    for role, text, ts in turns:
        u = str(uuid_mod.uuid4())
        if role == "user":
            rec = {"parentUuid": parent, **common, "type": "user",
                   "message": {"role": "user", "content": text},
                   "uuid": u, "timestamp": ts}
        else:
            rec = {"parentUuid": parent, **common, "type": "assistant",
                   "message": {"id": f"msg_import_{u.replace('-', '')[:24]}", "type": "message",
                               "role": "assistant", "model": model,
                               "content": [{"type": "text", "text": text}],
                               "stop_reason": "end_turn", "stop_sequence": None,
                               "usage": {"input_tokens": 0, "output_tokens": 0}},
                   "uuid": u, "timestamp": ts}
        records.append(rec)
        parent = u
    if conv.get("name"):
        records.append({"type": "ai-title", "aiTitle": conv["name"], "sessionId": cli_session_id})
    return records


def conversation_task_json(conv: dict[str, Any], cli_session_id: str, model: str) -> dict[str, Any]:
    first_user = ""
    for m in conv.get("chat_messages") or []:
        if isinstance(m, dict) and m.get("sender") == "human":
            first_user = _message_text(m)
            if first_user:
                break
    return {
        "sessionId": f"local_{conv['uuid']}",
        "processName": f"imported-{conv['uuid'][:8]}",
        "cliSessionId": cli_session_id,
        "cwd": "",
        "userSelectedFolders": [],
        "createdAt": _iso_to_ms(conv.get("created_at")),
        "lastActivityAt": _iso_to_ms(conv.get("updated_at") or conv.get("created_at")),
        "model": model,
        "isArchived": False,
        "title": conv.get("name") or "",
        "initialMessage": first_user[:4000],
        "permissionMode": "default",
        "memoryEnabled": True,
        "skillsEnabled": True,
        "pluginsEnabled": True,
        "importedFrom": {"kind": "claude.ai", "conversationUuid": conv["uuid"],
                         "summary": conv.get("summary") or ""},
    }


def _engine():
    """The cowork_export module that is driving us. When it runs as a script
    (or as the frozen sidecar) it is ``__main__``; importing it by name would
    load a second copy."""
    main = sys.modules.get("__main__")
    if main is not None and hasattr(main, "load_transcript") and hasattr(main, "render_markdown"):
        return main
    import cowork_export
    return cowork_export


def write_conversation_bundle(
    conv: dict[str, Any], target: Path, model: str, formats: list[str], space: dict[str, Any] | None = None,
) -> Path:
    """Write one chat as a ClaudeLift bundle (same layout `export` produces)."""
    ce = _engine()
    cli_id = str(uuid_mod.uuid4())
    target.mkdir(parents=True, exist_ok=True)
    records = conversation_records(conv, cli_id, model)
    with (target / "transcript.jsonl").open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    task = conversation_task_json(conv, cli_id, model)
    (target / "task.json").write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")
    if space:
        # The chat's claude.ai project, as a space record: import files the
        # task under the space of the same name on the target account.
        (target / "space").mkdir(parents=True, exist_ok=True)
        (target / "space" / "space.json").write_text(json.dumps(space, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # Raw chat as exported, for lossless reference (thinking, citations, tool ids).
    (target / "claudeai_conversation.json").write_text(json.dumps(conv, ensure_ascii=False, indent=1), encoding="utf-8")

    uploads: list[Path] = []
    for m in conv.get("chat_messages") or []:
        for a in (m.get("attachments") or []) if isinstance(m, dict) else []:
            if isinstance(a, dict) and a.get("extracted_content"):
                name = _safe_filename(a.get("file_name") or "", "attachment")
                dest = target / "uploads" / name
                if dest.suffix.lower() not in (".txt", ".md", ".csv", ".json"):
                    dest = dest.with_name(dest.name + ".txt")
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_text(a["extracted_content"], encoding="utf-8")
                uploads.append(dest)

    meta, raw = ce.load_transcript(target / "transcript.jsonl")
    meta.source = "claudeai"
    meta.task_id = conv["uuid"]
    meta.title = conv.get("name") or meta.title
    meta.model = model
    meta.initial_message = task["initialMessage"]
    meta.started_at = conv.get("created_at") or meta.started_at
    meta.ended_at = conv.get("updated_at") or meta.ended_at
    flat = ce.flatten(raw)
    if "html" in formats:
        (target / "session.html").write_text(ce.render_html(meta, flat, [], uploads, [], target), encoding="utf-8")
    if "md" in formats:
        (target / "session.md").write_text(ce.render_markdown(meta, flat, [], uploads, [], target), encoding="utf-8")
    if "json" in formats:
        (target / "session.json").write_text(ce.render_json(meta, flat, [], uploads, [], target), encoding="utf-8")
    if "csv" in formats:
        ce.write_csv(target / "session.csv", flat)

    manifest = {
        "bundle_version": ce.BUNDLE_VERSION,
        "tool": "claude-cowork-export",
        "tool_version": ce.TOOL_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "source_kind": "claudeai",
        "source_platform": sys.platform,
        "source_path_sep": "\\" if sys.platform == "win32" else "/",
        "source_home": "",
        "source_userdata": "",
        "source_sandbox_prefix": "",
        "source_task_id": conv["uuid"],
        "source_cli_session_id": cli_id,
        "source_cwd": "",
        "source_user_folders": [],
        "source_account_hint": (conv.get("account") or {}).get("uuid", ""),
        "source_space_id": (space or {}).get("id", ""),
        "source_space_name": (space or {}).get("name", ""),
        "auth": {"included": False},
    }
    (target / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    n_user = sum(1 for r in records if r.get("type") == "user")
    n_asst = sum(1 for r in records if r.get("type") == "assistant")
    (target / "README.md").write_text(
        f"# {conv.get('name') or conv['uuid']}\n\n"
        f"Imported from a claude.ai data export (conversation `{conv['uuid']}`).\n\n"
        f"- Created: {conv.get('created_at') or ''}\n- Updated: {conv.get('updated_at') or ''}\n"
        f"- Turns: {n_user} user, {n_asst} assistant\n\n"
        "- `transcript.jsonl` — Claude Code transcript (text turns, importable as a Cowork task)\n"
        "- `claudeai_conversation.json` — the chat exactly as exported\n"
        "- `session.*` — rendered transcript\n",
        encoding="utf-8",
    )
    return target


# ---------------------------------------------------------------------------
# Projects + memory → space bundles
# ---------------------------------------------------------------------------

def _memory_files(ex: ClaudeAiExport) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in ex.memories:
        out.extend(f for f in m.get("memory_files") or [] if isinstance(f, dict) and f.get("path"))
    return out


def local_space_links() -> dict[str, dict[str, Any]]:
    """claude.ai project uuid → the local Cowork space it was made from
    (spaces.json ``migration.projectUuid``): name and folders. Those projects
    keep their knowledge in the space folders on this PC, not in claude.ai."""
    ce = _engine()
    links: dict[str, dict[str, Any]] = {}
    for root in ce._cowork_roots():
        for sf in root.glob("*/*/spaces.json"):
            try:
                data = json.loads(sf.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            for sp in data.get("spaces") or [] if isinstance(data, dict) else []:
                puuid = ((sp or {}).get("migration") or {}).get("projectUuid")
                if puuid:
                    links[puuid] = {
                        "name": sp.get("name") or "",
                        "folders": [f["path"] for f in sp.get("folders") or [] if isinstance(f, dict) and f.get("path")],
                    }
    return links


def project_kind(project: dict[str, Any], target: Path, local: dict[str, Any] | None) -> str:
    """What a project holds, so an empty-looking one is not mistaken for a
    failed download: knowledge / cowork-space / instructions-only / empty."""
    pull = project.get("_pull") or {}
    if _count_files(target / "docs") or _count_files(target / "files"):
        return "knowledge"
    if local or pull.get("kind") == "cowork-space":
        return "cowork-space"
    return "instructions-only" if project.get("prompt_template") else "empty"


KIND_NOTE = {
    "knowledge": "",
    "cowork-space": "Cowork space: its files live in a folder on the PC it is linked to, not in claude.ai.",
    "instructions-only": "Instructions only: nothing was uploaded to this project.",
    "empty": "Nothing uploaded and no instructions.",
}


def project_caches() -> dict[str, Path]:
    """Claude Desktop's local copy of claude.ai projects used in Cowork:
    ``<cowork root>/<acct>/<org>/.project-cache/<project-uuid>/`` with
    ``metadata.json`` (name, description, prompt_template), ``docs/``,
    ``files/`` (uploaded PDFs / images, which the data export leaves out) and
    ``memory.md``. Newest copy wins when a project is cached twice."""
    ce = _engine()
    found: dict[str, Path] = {}
    for root in ce._cowork_roots():
        for cache in root.glob("*/*/.project-cache/*"):
            if not cache.is_dir():
                continue
            prev = found.get(cache.name)
            if prev is None or cache.stat().st_mtime > prev.stat().st_mtime:
                found[cache.name] = cache
    return found


def project_from_cache(cache: Path) -> dict[str, Any] | None:
    """A project record (export shape) rebuilt from a desktop project cache,
    for projects the data export does not cover (e.g. another organization)."""
    try:
        meta = json.loads((cache / "metadata.json").read_text(encoding="utf-8"))
    except Exception:
        return None
    docs = []
    for f in sorted((cache / "docs").glob("*")) if (cache / "docs").is_dir() else []:
        if f.is_file():
            try:
                docs.append({"uuid": "", "filename": f.name, "content": f.read_text(encoding="utf-8")})
            except (UnicodeDecodeError, OSError):
                continue
    return {
        "uuid": meta.get("uuid") or cache.name,
        "name": meta.get("name") or cache.name,
        "description": meta.get("description") or "",
        "prompt_template": meta.get("prompt_template") or "",
        "created_at": None,
        "updated_at": meta.get("synced_at"),
        "docs": docs,
        "source": "Claude Desktop project cache",
    }


def _doc_key(name: str) -> str:
    stem = name.rsplit("/", 1)[-1]
    for ext in (".md", ".txt"):
        if stem.lower().endswith(ext):
            stem = stem[: -len(ext)]
    return re.sub(r"[^a-z0-9]", "", stem.lower())


# ---------------------------------------------------------------------------
# Live project pull (scripts/pull-claude-projects.js output)
# ---------------------------------------------------------------------------

def _pull_list(v: Any) -> list[Any]:
    if isinstance(v, list):
        return v
    if isinstance(v, dict) and not v.get("__error"):
        for k in ("data", "projects", "items", "files", "docs"):
            if isinstance(v.get(k), list):
                return v[k]
    return []


def find_project_pulls(export_root: Path, prefix: str = "claude-projects-full") -> list[Path]:
    """Files from the console pull scripts (``<prefix>-*.json``): in the export
    folder, or (newest one) in the Downloads folder."""
    found: list[Path] = []
    roots = [export_root if export_root.is_dir() else export_root.parent]
    downloads = Path.home() / "Downloads"
    for r in roots:
        found.extend(sorted(r.glob(f"{prefix}*.json")))
    if not found and downloads.is_dir():
        newest = sorted(downloads.glob(f"{prefix}*.json"), key=lambda p: p.stat().st_mtime)
        found.extend(newest[-1:])
    return found


@dataclass
class PullData:
    """Everything read from console pull files (scripts/pull-claude-projects.js)."""
    projects: dict[str, dict[str, Any]] = field(default_factory=dict)   # uuid → {org, org_uuid, rec}
    orgs: list[dict[str, Any]] = field(default_factory=list)            # org records (memory, skills, chats, ...)
    profile: dict[str, Any] | None = None
    chats: dict[str, dict[str, Any]] = field(default_factory=dict)      # chat uuid → list entry (has project_uuid)
    bodies: dict[str, dict[str, Any]] = field(default_factory=dict)     # chat uuid → full conversation


def _pull_paths(export_root: Path | None, explicit: list[Path] | None) -> list[Path]:
    if explicit:
        return [p for p in explicit if p.is_file()]
    if export_root is None:
        return []
    return find_project_pulls(export_root, "claude-projects-full") + find_project_pulls(export_root, "claudelift-pull")


def load_pulls(export_root: Path | None, explicit: list[Path] | None = None) -> PullData:
    """Read every pull file (later files win), then merge second-pass blob
    downloads into the matching project file entries."""
    pd = PullData()
    for path in _pull_paths(export_root, explicit):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            print(f"  warn: could not read {path}: {e}", file=sys.stderr)
            continue
        if not isinstance(data, dict) or data.get("tool") != "claudelift-project-pull":
            continue
        profile = (data.get("account") or {}).get("profile")
        if isinstance(profile, dict) and not profile.get("__error"):
            pd.profile = profile
        for org in data.get("organizations") or []:
            pd.orgs.append(org)
            for rec in org.get("projects") or []:
                if isinstance(rec, dict) and rec.get("uuid"):
                    pd.projects[rec["uuid"]] = {"org": org.get("name") or "", "org_uuid": org.get("uuid") or "", "rec": rec}
            for c in org.get("chats") or []:
                if isinstance(c, dict) and c.get("uuid"):
                    pd.chats[c["uuid"]] = {**c, "_org": org.get("name") or ""}
            for b in org.get("chat_bodies") or []:
                if isinstance(b, dict) and b.get("uuid") and isinstance(b.get("chat_messages"), list):
                    pd.bodies[b["uuid"]] = b
    out = pd.projects
    # Second-pass downloads of "blob" files (scripts/pull-claude-project-blobs):
    # fill in the matching file entries by file uuid.
    blob_roots = {p.parent for p in _pull_paths(export_root, explicit)}
    if export_root is not None:
        blob_roots.add(export_root)
    blob_files = sorted({b for r in blob_roots for b in find_project_pulls(r, "claude-projects-blobs")})
    for path in blob_files:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(data, dict) or data.get("tool") != "claudelift-project-blobs":
            continue
        for b in data.get("files") or []:
            if not (isinstance(b, dict) and (b.get("data") or {}).get("base64")):
                continue
            entry = out.get(b.get("project") or "")
            for item in (entry or {}).get("rec", {}).get("files") or []:
                if (item.get("meta") or {}).get("file_uuid") == b.get("file_uuid"):
                    item["data"] = b["data"]
    return pd


def load_project_pulls(export_root: Path) -> dict[str, dict[str, Any]]:
    """project uuid → {"org": name, "rec": pulled project record}."""
    return load_pulls(export_root).projects


def _pull_doc_name(d: dict[str, Any]) -> str:
    return d.get("file_name") or d.get("filename") or d.get("name") or ""


def project_from_pull(entry: dict[str, Any]) -> dict[str, Any]:
    """A project record (export shape) built from a live pull, for projects the
    data export does not have."""
    rec = entry["rec"]
    proj = rec.get("project") if isinstance(rec.get("project"), dict) and not rec["project"].get("__error") else {}
    listed = rec.get("listed") or {}
    pick = lambda k: proj.get(k) if proj.get(k) is not None else listed.get(k)
    docs = [{"uuid": d.get("uuid") or "", "filename": _pull_doc_name(d), "content": d.get("content") or ""}
            for d in _pull_list(rec.get("docs")) if isinstance(d, dict)]
    return {
        "uuid": rec["uuid"],
        "name": pick("name") or rec["uuid"],
        "description": pick("description") or "",
        "prompt_template": pick("prompt_template") or "",
        "created_at": pick("created_at"),
        "updated_at": pick("updated_at"),
        "docs": docs,
        "source": "claude.ai live pull",
        "org": entry.get("org") or "",
        "_pull": rec,
    }


def _write_pull_extras(rec: dict[str, Any], target: Path, project: dict[str, Any]) -> None:
    """Docs the export lacks, uploaded files, sync sources and cloud memory
    from a live pull record."""
    import base64

    have = {_doc_key(d.get("filename") or "") for d in project.get("docs") or [] if isinstance(d, dict)}
    for d in _pull_list(rec.get("docs")):
        if not isinstance(d, dict) or not d.get("content"):
            continue
        name = _pull_doc_name(d)
        if _doc_key(name) in have:
            continue
        have.add(_doc_key(name))
        fname = _safe_filename(name, f"doc-{str(d.get('uuid'))[:8]}")
        if "." not in fname[-6:]:
            fname += ".md"
        dest = target / "docs" / fname
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(d["content"], encoding="utf-8")

    failed: list[dict[str, Any]] = []
    for item in rec.get("files") or []:
        meta = item.get("meta") or {}
        data = item.get("data") or {}
        name = _safe_filename(meta.get("file_name") or meta.get("name") or "", str(meta.get("file_uuid") or meta.get("uuid") or "file"))
        if not data.get("base64"):
            failed.append({"file": name, "reason": data.get("error") or data.get("skipped") or "no data"})
            continue
        dest = target / "files" / name
        if dest.exists():
            dest = dest.with_name(f"{dest.stem}-{str(meta.get('file_uuid') or meta.get('uuid') or '')[:8]}{dest.suffix}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(base64.b64decode(data["base64"]))
    if failed:
        (target / "files-not-downloaded.json").write_text(json.dumps(failed, ensure_ascii=False, indent=2), encoding="utf-8")

    syncs = rec.get("syncs")
    if _pull_list(syncs):
        (target / "sync-sources.json").write_text(json.dumps(syncs, ensure_ascii=False, indent=2), encoding="utf-8")
    memory = rec.get("memory")
    if isinstance(memory, (dict, list)) and not (isinstance(memory, dict) and memory.get("__error")) and memory:
        dest = target / "memory" / "cloud-memory.json"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(memory, ensure_ascii=False, indent=2), encoding="utf-8")
        text = memory.get("memory") if isinstance(memory, dict) else None
        if isinstance(text, str) and text.strip():
            (target / "memory" / "cloud-memory.md").write_text(text, encoding="utf-8")
    slim = {k: v for k, v in rec.items() if k not in ("files", "docs")}
    slim["files"] = [item.get("meta") for item in rec.get("files") or []]
    slim["docs"] = [{k: v for k, v in d.items() if k != "content"} for d in _pull_list(rec.get("docs")) if isinstance(d, dict)]
    (target / "live-pull.json").write_text(json.dumps(slim, ensure_ascii=False, indent=2), encoding="utf-8")


def _count_files(d: Path) -> int:
    return sum(1 for x in d.rglob("*") if x.is_file()) if d.is_dir() else 0


def write_project_bundle(
    project: dict[str, Any], ex: ClaudeAiExport, target: Path, cache: Path | None = None,
    local: dict[str, Any] | None = None,
) -> Path:
    """One claude.ai project, complete: ``INSTRUCTIONS.md`` (custom
    instructions), ``README.md``, ``docs/`` (project knowledge), ``files/``
    (uploaded files, from the desktop project cache when present),
    ``memory/`` (project memory), ``space.json`` (Cowork spaces.json shape, for
    import) and ``project.json`` (raw metadata)."""
    puuid = project["uuid"]
    target.mkdir(parents=True, exist_ok=True)
    instructions = project.get("prompt_template") or ""
    space = {
        "id": puuid,
        "name": project.get("name") or puuid,
        # The local Cowork space's folders, so an import on the same PC
        # re-attaches them (import keeps only folders that exist).
        "folders": [{"path": f} for f in (local or {}).get("folders") or []],
        "projects": [],
        "links": [],
        "instructions": instructions,
        "origin": "import",  # what Claude Desktop's own claude.ai importer writes
        "createdAt": _iso_to_ms(project.get("created_at")),
        "updatedAt": _iso_to_ms(project.get("updated_at")),
    }
    (target / "space.json").write_text(json.dumps(space, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    raw = {k: v for k, v in project.items() if k != "docs"}
    raw["docs"] = [{k: v for k, v in d.items() if k != "content"} for d in project.get("docs") or []]
    (target / "project.json").write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    used: set[str] = set()
    for d in project.get("docs") or []:
        if not isinstance(d, dict):
            continue
        name = _safe_filename(d.get("filename") or "", f"doc-{str(d.get('uuid'))[:8]}")
        if "." not in name.rsplit("_", 1)[-1][-6:]:
            name += ".md"  # knowledge docs typed in claude.ai have no extension
        stem, dot, ext = name.rpartition(".")
        candidate, i = name, 2
        while candidate.lower() in used:
            candidate = f"{stem or name}-{i}{dot}{ext}" if dot else f"{name}-{i}"
            i += 1
        used.add(candidate.lower())
        dest = target / "docs" / candidate
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(d.get("content") or "", encoding="utf-8")

    prefix = f"/projects/{puuid}/"
    for f in _memory_files(ex):
        if f["path"].startswith(prefix):
            rel = f["path"][len(prefix):]
            parts = [_safe_filename(p, "_") for p in rel.split("/") if p]
            if not parts:
                continue
            dest = target / "memory" / Path(*parts)
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(f.get("content") or "", encoding="utf-8")
    summaries = [m.get("project_memories", {}).get(puuid) for m in ex.memories]
    summary = next((s for s in summaries if s), "")
    if summary:
        dest = target / "memory" / "project-memory-summary.md"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(f"# Project memory summary (claude.ai)\n\n{summary}\n", encoding="utf-8")

    if cache is not None:
        # Docs the export lacks (matched by name), uploaded files, cached memory.
        have = {_doc_key(d.get("filename") or "") for d in project.get("docs") or [] if isinstance(d, dict)}
        for f in sorted((cache / "docs").glob("*")) if (cache / "docs").is_dir() else []:
            if f.is_file() and _doc_key(f.name) not in have:
                dest = target / "docs" / _safe_filename(f.name, f.name)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, dest)
        for f in sorted((cache / "files").rglob("*")) if (cache / "files").is_dir() else []:
            if f.is_file():
                dest = target / "files" / f.relative_to(cache / "files")
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(f, dest)
        if (cache / "memory.md").is_file() and not summary:
            dest = target / "memory" / "project-memory-summary.md"
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(cache / "memory.md", dest)

    pull = project.get("_pull")
    if isinstance(pull, dict):
        _write_pull_extras(pull, target, project)

    name = project.get("name") or puuid
    (target / "INSTRUCTIONS.md").write_text(
        f"# {name} — custom instructions\n\n{instructions or '(none)'}\n", encoding="utf-8")
    source = project.get("source") or "claude.ai data export"
    if cache is not None and not project.get("source"):
        source += " + Claude Desktop project cache"
    if pull is not None and "live pull" not in source:
        source += " + claude.ai live pull"
    kind = project_kind(project, target, local)
    lines = [f"# {name}", ""]
    if project.get("org"):
        lines += [f"Organization: {project['org']}", ""]
    if KIND_NOTE[kind]:
        lines += [f"> {KIND_NOTE[kind]}", ""]
    if local and local.get("folders"):
        lines += ["Local folders (Cowork space):", ""] + [f"- `{f}`" for f in local["folders"]] + [""]
    if project.get("description"):
        lines += [project["description"], ""]
    lines += [
        f"- Project id: `{puuid}`",
        f"- Created: {project.get('created_at') or ''}",
        f"- Updated: {project.get('updated_at') or ''}",
        f"- Source: {source}",
        "",
        f"- `INSTRUCTIONS.md` — custom instructions ({len(instructions)} chars)",
        f"- `docs/` — {_count_files(target / 'docs')} knowledge doc(s)",
        f"- `files/` — {_count_files(target / 'files')} uploaded file(s)",
        f"- `memory/` — {_count_files(target / 'memory')} memory file(s)",
    ]
    (target / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return target


def write_account_memory(ex: ClaudeAiExport, target: Path) -> int:
    """Account-level memory (everything outside /projects/) plus the
    conversations memory summary."""
    n = 0
    for f in _memory_files(ex):
        if f["path"].startswith("/projects/"):
            continue
        parts = [_safe_filename(p, "_") for p in f["path"].split("/") if p]
        if not parts:
            continue
        dest = target / Path(*parts)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(f.get("content") or "", encoding="utf-8")
        n += 1
    for m in ex.memories:
        if m.get("conversations_memory"):
            target.mkdir(parents=True, exist_ok=True)
            (target / "conversations-memory-summary.md").write_text(
                "# Conversations memory summary (claude.ai)\n\n" + m["conversations_memory"] + "\n", encoding="utf-8")
            n += 1
    return n


def _synced_skills_dirs(org_uuid: str) -> list[Path]:
    """Claude Code's local copy of an organization's skills
    (``~/.claude/skills/synced/<org>_<account>/``)."""
    root = Path.home() / ".claude" / "skills" / "synced"
    return sorted(d for d in root.glob(f"{org_uuid}_*") if d.is_dir()) if root.is_dir() else []


def _plugin_has_literal_secret(plugin_dir: Path) -> bool:
    """True when the plugin's .mcp.json carries a literal env / header value
    (an API key typed into the config instead of a ${VAR} placeholder)."""
    try:
        data = json.loads((plugin_dir / ".mcp.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    servers = data.get("mcpServers", data) if isinstance(data, dict) else {}
    for s in servers.values() if isinstance(servers, dict) else []:
        if not isinstance(s, dict):
            continue
        for block in (s.get("env") or {}, s.get("headers") or {}):
            for v in block.values() if isinstance(block, dict) else []:
                if isinstance(v, str) and v and "${" not in v:
                    return True
    return False


def write_plugins(org_uuid: str, od: Path) -> int:
    """Every Cowork plugin installed in the organization, as a zip ready for
    Customize → Plugins → Upload on the new account. Source: the plugin
    folders Claude Desktop keeps per account
    (``<cowork root>/<acct>/<org>/rpm/<plugin id>/`` + ``manifest.json``),
    which are standard plugins (``.claude-plugin/plugin.json``, skills,
    commands, hooks, ``.mcp.json``). Also writes ``plugins.json`` (name,
    marketplace, who installed it, zip, secret flag) and returns files written."""
    ce = _engine()
    n = 0
    seen: set[str] = set()
    listing: list[dict[str, Any]] = []
    for root in ce._cowork_roots():
        for manifest in root.glob(f"*/{org_uuid}/rpm/manifest.json"):
            try:
                data = json.loads(manifest.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            for pl in data.get("plugins") or []:
                pid, name = pl.get("id") or "", pl.get("name") or pl.get("id") or ""
                src = manifest.parent / pid
                if not pid or pid in seen or not (src / ".claude-plugin" / "plugin.json").is_file():
                    continue
                seen.add(pid)
                zpath = od / "plugins-upload" / f"{_safe_filename(name, pid)}.zip"
                zpath.parent.mkdir(parents=True, exist_ok=True)
                with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
                    for f in sorted(src.rglob("*")):
                        if f.is_file():
                            zf.write(f, f.relative_to(src))
                n += 1
                listing.append({
                    "name": name, "id": pid, "marketplace": pl.get("marketplaceName") or "",
                    "installed_by": pl.get("installedBy") or "", "updated_at": pl.get("updatedAt") or "",
                    "uploaded_by_you": pl.get("marketplaceName") == "My Uploads",
                    "contains_literal_secret": _plugin_has_literal_secret(src),
                    "zip": zpath.relative_to(od).as_posix(),
                })
    if listing:
        od.mkdir(parents=True, exist_ok=True)
        (od / "plugins.json").write_text(json.dumps(listing, ensure_ascii=False, indent=2), encoding="utf-8")
        n += 1
    return n


def write_reinstall_guide(target: Path) -> None:
    """account/REINSTALL.md: what to upload / reconnect on the new account."""
    lines = ["# Put it back on the new account", ""]
    for od in sorted(p for p in target.iterdir() if p.is_dir()):
        plugins = json.loads((od / "plugins.json").read_text(encoding="utf-8")) if (od / "plugins.json").exists() else []
        skills = sorted((od / "custom-skills-upload").glob("*.zip")) if (od / "custom-skills-upload").is_dir() else []
        conns = json.loads((od / "connectors.json").read_text(encoding="utf-8")) if (od / "connectors.json").exists() else []
        conns = conns if isinstance(conns, list) else (conns.get("data") or conns.get("servers") or []) if isinstance(conns, dict) else []
        if not (plugins or skills or conns):
            continue
        lines += [f"## {od.name}", ""]
        if plugins:
            lines += ["### Plugins — Customize → Plugins → Upload (one zip each)", ""]
            for p in plugins:
                flag = " — **has an API key inside `.mcp.json`**" if p.get("contains_literal_secret") else ""
                src = "your upload" if p.get("uploaded_by_you") else f"marketplace: {p.get('marketplace')}"
                lines.append(f"- `{p['zip']}` ({src}){flag}")
            lines.append("")
        if skills:
            lines += ["### Your own skills — Customize → Skills → Upload", ""]
            lines += [f"- `custom-skills-upload/{s.name}`" for s in skills] + [""]
        if conns:
            lines += ["### Connectors — Customize → Connectors (sign in to each again)", ""]
            for c in conns:
                if isinstance(c, dict):
                    lines.append(f"- {c.get('name') or c.get('display_name') or c.get('uuid')} — {c.get('url') or ''}".rstrip(" —"))
            lines.append("")
    lines += ["### This PC only (not tied to an account)", "",
              "Claude Desktop extensions and the MCP servers in `claude_desktop_config.json` belong to the "
              "Windows user, not the Claude account: signing in to another account on the same PC keeps them.", ""]
    if (target / "profile.md").exists():
        lines += ["### Settings", "", "Paste `profile.md` into the new account's settings.", ""]
    (target / "REINSTALL.md").write_text("\n".join(lines), encoding="utf-8")


def write_account(pd: PullData, target: Path) -> int:
    """Account-level settings from a live pull: profile, and per organization
    memory, memory settings, skills (list + the skill folders Claude Code has
    synced to this PC), styles and the chat index. Returns files written."""
    n = 0

    def dump(path: Path, data: Any) -> None:
        nonlocal n
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        n += 1

    if pd.profile:
        dump(target / "profile.json", pd.profile)
        # The parts a person pastes into the new account's settings.
        parts = ["# Claude account settings", ""]
        for key, title, where in (
            ("conversation_preferences", "Personal preferences",
             "claude.ai → Settings → General → \"What personal preferences should Claude consider in responses?\""),
            ("cowork_global_instructions", "Cowork global instructions", "Claude Desktop → Cowork settings → global instructions"),
            ("work_function", "Work function", "claude.ai → Settings → General"),
        ):
            val = pd.profile.get(key)
            if val:
                parts += [f"## {title}", "", f"_Where: {where}_", "", str(val), ""]
        (target / "profile.md").write_text("\n".join(parts), encoding="utf-8")
        n += 1
    for org in pd.orgs:
        if not org.get("projects") and not org.get("chats") and not org.get("skills"):
            continue  # no chat surface (API-only / customer org)
        od = target / _safe_filename(f"{org.get('name') or 'org'} ({str(org.get('uuid'))[:8]})", "org")
        mem = org.get("memory")
        if isinstance(mem, dict) and not mem.get("__error"):
            dump(od / "memory.json", mem)
            if isinstance(mem.get("memory"), str) and mem["memory"].strip():
                (od / "memory.md").write_text(mem["memory"], encoding="utf-8")
                n += 1
        for key, name in (("memory_settings", "memory-settings.json"), ("styles", "styles.json")):
            val = org.get(key)
            if val is not None and not (isinstance(val, dict) and val.get("__error")):
                dump(od / name, val)
        if org.get("skills"):
            dump(od / "skills-list.json", org["skills"])
        for d in _synced_skills_dirs(str(org.get("uuid") or "")):
            for f in d.rglob("*"):
                if f.is_file():
                    dest = od / "skills" / f.relative_to(d)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(f, dest)
                    n += 1
            # Skills the user wrote (not plugin / Anthropic ones) as zips ready
            # for claude.ai → Customize → Skills → Upload on the new account.
            try:
                manifest = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                manifest = {}
            for sk in manifest.get("skills") or []:
                name = sk.get("name") or ""
                src = d / name
                if sk.get("source") != "custom" or not name or not (src / "SKILL.md").is_file():
                    continue
                zpath = od / "custom-skills-upload" / f"{_safe_filename(name, 'skill')}.zip"
                zpath.parent.mkdir(parents=True, exist_ok=True)
                with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as zf:
                    for f in sorted(src.rglob("*")):
                        if f.is_file():
                            zf.write(f, Path(name) / f.relative_to(src))
                n += 1
        n += write_plugins(str(org.get("uuid") or ""), od)
        conns = org.get("connectors")
        if conns is not None and not (isinstance(conns, dict) and conns.get("__error")):
            dump(od / "connectors.json", conns)
        plist = org.get("plugins")
        if plist is not None and not (isinstance(plist, dict) and plist.get("__error")):
            dump(od / "plugins-account-list.json", plist)
        chats = org.get("chats") or []
        if chats:
            names = {rec["uuid"]: (rec.get("project") or {}).get("name") or (rec.get("listed") or {}).get("name") or ""
                     for rec in org.get("projects") or [] if isinstance(rec, dict) and rec.get("uuid")}
            index = [{
                "uuid": c.get("uuid"), "name": c.get("name"), "created_at": c.get("created_at"),
                "updated_at": c.get("updated_at"), "model": c.get("model"), "is_starred": c.get("is_starred"),
                "project_uuid": c.get("project_uuid"), "project_name": names.get(c.get("project_uuid") or "", ""),
            } for c in chats if isinstance(c, dict)]
            dump(od / "chats-index.json", index)
    if target.is_dir():
        write_reinstall_guide(target)
        n += 1
    return n


def copy_artifacts(ex: ClaudeAiExport, target: Path) -> int:
    n = 0
    for src, prefix in ex.artifact_sources:
        if src.is_file():
            with zipfile.ZipFile(src) as zf:
                for info in zf.infolist():
                    if info.is_dir() or not info.filename.startswith(prefix):
                        continue
                    rel = info.filename[len(prefix):]
                    dest = target / rel
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with zf.open(info) as fin, dest.open("wb") as fout:
                        shutil.copyfileobj(fin, fout)
                    n += 1
        else:
            for p in src.rglob("*"):
                if p.is_file():
                    dest = target / p.relative_to(src)
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(p, dest)
                    n += 1
    return n


def convert(
    export_root: Path | None,
    out: Path,
    *,
    what: set[str],
    pull_paths: list[Path] | None = None,
    model: str = DEFAULT_MODEL,
    formats: list[str] | None = None,
    since: str | None = None,
    match: str | None = None,
    limit: int | None = None,
    emit=None,
) -> dict[str, int]:
    """Convert a claude.ai export into ClaudeLift bundles under ``out``."""
    formats = formats if formats is not None else ["md"]
    ex = load_export(export_root) if export_root is not None else ClaudeAiExport()
    pd = load_pulls(export_root, pull_paths)
    # Chats only the live pull has (newer than the export, or from another org).
    have = {c["uuid"] for c in ex.conversations}
    for uuid, body in pd.bodies.items():
        if uuid not in have:
            ex.conversations.append(body)
    ex.conversations.sort(key=lambda c: c.get("updated_at") or c.get("created_at") or "", reverse=True)
    out.mkdir(parents=True, exist_ok=True)
    counts = {"conversations": 0, "projects": 0, "memory_files": 0, "design_chats": 0, "artifact_files": 0,
              "account_files": 0}

    def note(event: dict[str, Any]) -> None:
        if emit:
            emit(event)

    if "projects" in what:
        caches = project_caches()
        links = local_space_links()
        pulls = pd.projects
        projects = []
        for p in ex.projects:
            if p["uuid"] in pulls:
                p = {**p, "_pull": pulls[p["uuid"]]["rec"], "org": pulls[p["uuid"]]["org"]}
            projects.append(p)
        known = {p["uuid"] for p in projects}
        for puuid, entry in pulls.items():
            if puuid not in known:
                projects.append(project_from_pull(entry))
                known.add(puuid)
        for puuid, cache in caches.items():
            if puuid not in known:
                extra = project_from_cache(cache)
                if extra:
                    projects.append(extra)
        index = ["# Claude projects", "",
                 "| Project | Org | Kind | Instructions | Docs | Files | Memory | Folder |",
                 "|---|---|---|---|---|---|---|---|"]
        for p in sorted(projects, key=lambda x: (x.get("name") or "").lower()):
            folder = f"{_safe_filename(p.get('name') or '', 'Untitled')[:80]} ({p['uuid'][:8]})"
            target = out / "projects" / folder
            write_project_bundle(p, ex, target, caches.get(p["uuid"]), links.get(p["uuid"]))
            counts["projects"] += 1
            kind = project_kind(p, target, links.get(p["uuid"]))
            index.append(
                f"| {p.get('name') or p['uuid']} | {p.get('org') or ''} | {kind} | {len(p.get('prompt_template') or '')} chars "
                f"| {_count_files(target / 'docs')} | {_count_files(target / 'files')} "
                f"| {_count_files(target / 'memory')} | `{folder}` |"
            )
            note({"event": "project_done", "uuid": p["uuid"], "name": p.get("name"), "kind": kind})
        (out / "projects" / "INDEX.md").write_text("\n".join(index) + "\n", encoding="utf-8")
    if "memory" in what:
        counts["memory_files"] = write_account_memory(ex, out / "memory")
    if "account" in what:
        counts["account_files"] = write_account(pd, out / "account")
    if "conversations" in what:
        convs = ex.conversations
        if since:
            convs = [c for c in convs if (c.get("updated_at") or c.get("created_at") or "") >= since]
        if match:
            needle = match.lower()
            convs = [c for c in convs if needle in (c.get("name") or "").lower()]
        if limit is not None:
            convs = convs[:limit]
        total = len(convs)
        # Project of each chat (the export does not record it; the pull's chat
        # list does), as the space the imported task belongs to.
        proj_info: dict[str, dict[str, Any]] = {p["uuid"]: p for p in ex.projects}
        for puuid, entry in pd.projects.items():
            proj_info.setdefault(puuid, project_from_pull(entry))
        for i, c in enumerate(convs, 1):
            if not any(isinstance(m, dict) for m in c.get("chat_messages") or []):
                continue
            puuid = c.get("project_uuid") or (pd.chats.get(c["uuid"]) or {}).get("project_uuid")
            proj = proj_info.get(puuid or "")
            space = {"id": puuid, "name": proj.get("name") or puuid, "instructions": proj.get("prompt_template") or "",
                     "origin": "import", "folders": []} if proj else None
            write_conversation_bundle(c, out / "conversations" / c["uuid"], model, formats, space)
            counts["conversations"] += 1
            note({"event": "conversation_done", "index": i, "total": total, "uuid": c["uuid"], "name": c.get("name")})
    if "design" in what and ex.design_chats:
        d_out = out / "design_chats"
        d_out.mkdir(parents=True, exist_ok=True)
        for d in ex.design_chats:
            (d_out / f"{d.get('uuid')}.json").write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
            counts["design_chats"] += 1
    if "artifacts" in what:
        counts["artifact_files"] = copy_artifacts(ex, out / "artifacts")
    (out / "claudeai-export-index.json").write_text(json.dumps({
        "converted_at": datetime.now(timezone.utc).isoformat(),
        "source": str(export_root) if export_root else "",
        "pull_files": [str(x) for x in _pull_paths(export_root, pull_paths)],
        "account": ex.users[0].get("uuid") if ex.users else "",
        "counts": counts,
        "projects": [{"uuid": p["uuid"], "name": p.get("name")} for p in ex.projects],
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return counts
