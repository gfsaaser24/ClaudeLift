#!/usr/bin/env python3
"""cowork_export — export Claude Cowork (or Claude Code) sessions to HTML / Markdown / JSON / CSV.

Cowork stores each chat as a "task" under the Claude desktop app's user-data dir:
    macOS:   ~/Library/Application Support/Claude/local-agent-mode-sessions/<acct>/<ws>/
    Windows: %APPDATA%\\Claude\\local-agent-mode-sessions\\<acct>\\<ws>\\
    Linux:   ~/.config/Claude/local-agent-mode-sessions/<acct>/<ws>/

Each task lays out:
    local_<task>.json                            # task metadata
    local_<task>/                                # task working dir
        .claude/projects/<encoded-cwd>/*.jsonl   # transcript (lossless)
        uploads/                                 # user-attached files
        outputs/                                 # files the assistant generated
        audit.jsonl                              # audit log
spaces.json                                      # space (project) registry

This tool (Windows branch) flattens that into HTML / MD / JSON / CSV plus a
snapshot of uploads, outputs, and any other files the assistant wrote. Falls
back to the legacy ~/.claude/projects/ layout when run with --source code.

Usage:
    python cowork_export.py list
    python cowork_export.py export latest
    python cowork_export.py export <task-id-prefix>
    python cowork_export.py export all --output .\\exports
    python cowork_export.py export latest --formats html,md
    python cowork_export.py export latest --source code        # legacy code mode
"""
from __future__ import annotations

import argparse
import csv
import errno
import html as html_mod
import json
import os
import shutil
import sys
import textwrap
import traceback
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

if sys.platform == "win32":
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8", line_buffering=True)
        except (AttributeError, OSError):
            pass


HOME = Path.home()


def _cowork_roots() -> list[Path]:
    """Return every plausible Cowork sessions root for this platform.

    On Windows MSIX/Store installs the same workspace is split across two
    locations and neither is a complete view on its own:

      * ``%APPDATA%\\Claude\\local-agent-mode-sessions`` — the public reparse
        mirror. Tends to expose only the *currently active* task in full
        detail (uploads, audit.jsonl, .claude/...). Sibling task directories
        and their metadata json files may be missing here.
      * ``%LOCALAPPDATA%\\Packages\\Claude_*\\LocalCache\\Roaming\\Claude\\
        local-agent-mode-sessions`` — the package's persistent store. Lists
        every task in the workspace (with metadata + audit.jsonl), but the
        active task's directory may be a sparse stub here.

    Discovery walks both and merges by task id, picking whichever side has
    the more complete record per task.
    """
    if sys.platform == "win32":
        roots: list[Path] = []
        local = os.environ.get("LOCALAPPDATA")
        local_base = Path(local) if local else (HOME / "AppData" / "Local")
        for pkg in sorted((local_base / "Packages").glob("Claude_*")):
            cand = pkg / "LocalCache" / "Roaming" / "Claude" / "local-agent-mode-sessions"
            if cand.exists():
                roots.append(cand)
        appdata = os.environ.get("APPDATA")
        base = Path(appdata) if appdata else (HOME / "AppData" / "Roaming")
        cand = base / "Claude" / "local-agent-mode-sessions"
        if cand.exists():
            roots.append(cand)
        return roots
    if sys.platform == "darwin":
        cand = HOME / "Library" / "Application Support" / "Claude" / "local-agent-mode-sessions"
    else:
        cand = HOME / ".config" / "Claude" / "local-agent-mode-sessions"
    return [cand] if cand.exists() else []


def _detect_cowork_root() -> Path:
    """Best-effort single-root for user-facing messages. Discovery itself
    iterates over :func:`_cowork_roots`, so this only needs to be plausible
    for the 'no sessions found under …' warning."""
    found = _cowork_roots()
    if found:
        return found[0]
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        base = Path(appdata) if appdata else (HOME / "AppData" / "Roaming")
        return base / "Claude" / "local-agent-mode-sessions"
    if sys.platform == "darwin":
        return HOME / "Library" / "Application Support" / "Claude" / "local-agent-mode-sessions"
    return HOME / ".config" / "Claude" / "local-agent-mode-sessions"


COWORK_ROOT = _detect_cowork_root()
CODE_ROOT = HOME / ".claude" / "projects"
DEFAULT_OUTPUT = Path.cwd() / "exports"
SUPPORTED_FORMATS = ("html", "md", "json", "csv")
TOOL_RESULT_TRUNCATE = 8000
BUNDLE_VERSION = 1
TOOL_VERSION = "0.5.0-desktop"
SEED_TEXT_TRUNCATE = 500
SEED_TOOL_INPUT_TRUNCATE = 200
SEED_TOOL_RESULT_TRUNCATE = 400


# Auth artefacts Cowork desktop maintains under its userData dir.
# `Cookies`, `Local State`, Local/Session Storage, etc. are encrypted with the
# platform's keystore (macOS Keychain, Windows DPAPI) and can only be migrated
# WITHIN the same platform — they are surface for --include-auth but force an
# abort for cross-platform import.
COWORK_AUTH_RELATIVE = [
    "buddy-tokens.json",
    "Local State",
    "Cookies",
    "Network Persistent State",
    "ant-did",
    "TransportSecurity",
]


def _rel_to(abs_p: Path, base: Path) -> str | None:
    """Return abs_p relative to base (forward slashes), or None if not under base.

    On Windows, falls back to a case-insensitive comparison because the
    filesystem is case-insensitive but pathlib.Path.relative_to is strict.
    """
    try:
        return str(abs_p.relative_to(base)).replace("\\", "/")
    except ValueError:
        if sys.platform == "win32":
            try:
                a_str = os.path.abspath(str(abs_p))
                b_str = os.path.abspath(str(base))
                a_norm = os.path.normcase(a_str)
                b_norm = os.path.normcase(b_str)
                if a_norm == b_norm:
                    return ""
                if a_norm.startswith(b_norm + os.sep):
                    return a_str[len(b_str) + 1:].replace("\\", "/")
            except OSError:
                pass
        return None


# ---------------------------------------------------------------------------
# Discovery — Cowork tasks
# ---------------------------------------------------------------------------

@dataclass
class Task:
    source: str
    task_id: str
    title: str = ""
    model: str = ""
    workspace_dir: Path | None = None
    task_meta_file: Path | None = None
    task_dir: Path | None = None
    transcript_path: Path | None = None
    cli_session_id: str = ""
    cwd: str = ""
    initial_message: str = ""
    user_folders: list[str] = field(default_factory=list)
    created_at_ms: int = 0
    last_activity_ms: int = 0
    archived: bool = False
    error: str = ""
    space_name: str = ""
    space_id: str = ""

    @property
    def display_when(self) -> str:
        ts = self.last_activity_ms or self.created_at_ms
        if not ts:
            return ""
        return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d %H:%M")

    @property
    def display_title(self) -> str:
        return self.title or f"(untitled task {self.task_id[:8]})"


def _load_spaces(workspace_dir: Path) -> tuple[dict[str, str], dict[str, str]]:
    """Return (folder_path -> space_name, project_uuid -> space_name)."""
    by_folder: dict[str, str] = {}
    by_project: dict[str, str] = {}
    sf = workspace_dir / "spaces.json"
    if not sf.exists():
        return by_folder, by_project
    try:
        data = json.loads(sf.read_text(encoding="utf-8"))
    except Exception:
        return by_folder, by_project
    for s in data.get("spaces", []):
        name = s.get("name", "")
        for fld in s.get("folders", []) or []:
            p = fld.get("path")
            if p:
                by_folder[p] = name
        for prj in s.get("projects", []) or []:
            u = prj.get("uuid")
            if u:
                by_project[u] = name
    return by_folder, by_project


def _resolve_transcript(task_dir: Path, cli_session_id: str) -> Path | None:
    """Locate the transcript file for a Cowork task.

    Preference order:
      1. ``<task>/.claude/projects/<encoded-cwd>/<cli-id>.jsonl`` — Claude Code's
         native transcript. Present on macOS Cowork.
      2. ``<task>/audit.jsonl`` — Cowork's audit log, which doubles as the
         conversation record on Windows where the native transcript is not
         written to disk (the ``.claude/projects/<encoded-cwd>/`` directory is
         created but stays empty).
    """
    pdir = task_dir / ".claude" / "projects"
    if pdir.exists():
        candidates = list(pdir.glob("*/*.jsonl"))
        if candidates:
            if cli_session_id:
                for c in candidates:
                    if c.stem == cli_session_id:
                        return c
            candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
            return candidates[0]
    audit = task_dir / "audit.jsonl"
    try:
        if audit.exists() and audit.stat().st_size > 0:
            return audit
    except OSError:
        pass
    return None


def _enumerate_root_tasks(root: Path) -> list[Task]:
    out: list[Task] = []
    if not root.exists():
        return out
    for acct in sorted(root.iterdir()):
        if not acct.is_dir():
            continue
        for workspace in sorted(acct.iterdir()):
            if not workspace.is_dir():
                continue
            spaces_by_folder, _ = _load_spaces(workspace)
            for meta_file in sorted(workspace.glob("local_*.json")):
                try:
                    meta = json.loads(meta_file.read_text(encoding="utf-8"))
                except Exception:
                    continue
                task_id = meta.get("sessionId") or meta_file.stem
                if task_id.startswith("local_"):
                    task_id = task_id[len("local_"):]
                task_dir = workspace / f"local_{task_id}"
                cli_id = meta.get("cliSessionId") or ""
                transcript = _resolve_transcript(task_dir, cli_id) if task_dir.exists() else None
                user_folders = meta.get("userSelectedFolders") or []
                space_name = ""
                for f in user_folders:
                    if f in spaces_by_folder:
                        space_name = spaces_by_folder[f]
                        break
                out.append(Task(
                    source="cowork",
                    task_id=task_id,
                    title=meta.get("title", "") or "",
                    model=meta.get("model", "") or "",
                    workspace_dir=workspace,
                    task_meta_file=meta_file,
                    task_dir=task_dir if task_dir.exists() else None,
                    transcript_path=transcript,
                    cli_session_id=cli_id,
                    cwd=meta.get("cwd", "") or "",
                    initial_message=meta.get("initialMessage", "") or "",
                    user_folders=list(user_folders),
                    created_at_ms=int(meta.get("createdAt") or 0),
                    last_activity_ms=int(meta.get("lastActivityAt") or 0),
                    archived=bool(meta.get("isArchived")),
                    error=meta.get("error", "") or "",
                    space_name=space_name,
                ))
    return out


def _pick_best_task(candidates: list[Task]) -> Task:
    """Pick the most informative Task record when the same task_id appears
    across multiple roots (e.g. APPDATA reparse + MSIX LocalCache on Windows).

    Score:
      1. has transcript_path (we can actually read the conversation)
      2. transcript file size (proxy for completeness)
      3. has task_dir (uploads/outputs reachable)
      4. larger task_meta_file (active task tends to be richer)
    """
    if len(candidates) == 1:
        return candidates[0]

    def _size(p: Path | None) -> int:
        if not p:
            return 0
        try:
            return p.stat().st_size
        except OSError:
            return 0

    def score(t: Task) -> tuple[int, int, int, int]:
        return (
            1 if t.transcript_path else 0,
            _size(t.transcript_path),
            1 if t.task_dir else 0,
            _size(t.task_meta_file),
        )

    return max(candidates, key=score)


def discover_cowork_tasks(roots: list[Path] | None = None) -> list[Task]:
    if roots is None:
        roots = _cowork_roots()
    if not roots:
        return []
    by_id: dict[str, list[Task]] = {}
    for root in roots:
        for t in _enumerate_root_tasks(root):
            by_id.setdefault(t.task_id, []).append(t)
    merged = [_pick_best_task(cs) for cs in by_id.values()]
    merged.sort(key=lambda t: t.last_activity_ms or t.created_at_ms, reverse=True)
    return merged


def discover_code_sessions(root: Path = CODE_ROOT) -> list[Task]:
    if not root.exists():
        return []
    out: list[Task] = []
    for proj in sorted(root.iterdir()):
        if not proj.is_dir():
            continue
        for jf in proj.glob("*.jsonl"):
            mtime_ms = int(jf.stat().st_mtime * 1000)
            t = Task(
                source="code",
                task_id=jf.stem,
                workspace_dir=proj,
                transcript_path=jf,
                cli_session_id=jf.stem,
                last_activity_ms=mtime_ms,
                created_at_ms=mtime_ms,
            )
            try:
                with jf.open("r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            obj = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if not t.cwd and obj.get("cwd"):
                            t.cwd = obj["cwd"]
                        if obj.get("type") == "ai-title":
                            t.title = obj.get("aiTitle", "") or t.title
                        if t.title and t.cwd:
                            break
            except OSError:
                pass
            out.append(t)
    out.sort(key=lambda x: x.last_activity_ms, reverse=True)
    return out


def discover(source: str, cowork_root_override: Path | None = None) -> list[Task]:
    cowork_roots = [cowork_root_override] if cowork_root_override else None
    if source == "cowork":
        return discover_cowork_tasks(cowork_roots)
    if source == "code":
        return discover_code_sessions()
    if source == "both":
        return sorted(
            discover_cowork_tasks(cowork_roots) + discover_code_sessions(),
            key=lambda t: t.last_activity_ms or t.created_at_ms,
            reverse=True,
        )
    raise ValueError(f"unknown source: {source}")


def resolve_tasks(selector: str, tasks: list[Task]) -> list[Task]:
    if not tasks:
        return []
    if selector == "all":
        return tasks
    if selector == "latest":
        return [tasks[0]]
    matches = [t for t in tasks if t.task_id.startswith(selector)]
    if matches:
        return matches
    matches = [t for t in tasks if selector in t.task_id]
    return matches


# ---------------------------------------------------------------------------
# Transcript parsing (shared by cowork + code)
# ---------------------------------------------------------------------------

@dataclass
class SessionMeta:
    source: str = ""
    task_id: str = ""
    cli_session_id: str = ""
    title: str = ""
    cwd: str = ""
    git_branch: str = ""
    version: str = ""
    started_at: str = ""
    ended_at: str = ""
    entrypoint: str = ""
    permission_mode: str = ""
    model: str = ""
    initial_message: str = ""
    user_folders: list[str] = field(default_factory=list)
    archived: bool = False
    error: str = ""
    space_name: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {**self.__dict__}


@dataclass
class FlatMessage:
    index: int
    kind: str
    role: str
    timestamp: str
    uuid: str = ""
    parent_uuid: str = ""
    text: str = ""
    tool_name: str = ""
    tool_id: str = ""
    tool_input: Any = None
    is_error: bool = False
    attachment_type: str = ""
    attachment_payload: Any = None
    extra: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {**self.__dict__}


def _normalize_audit_record(obj: dict[str, Any]) -> dict[str, Any] | None:
    """Adapt an audit.jsonl record to the transcript.jsonl shape that
    flatten() expects. Returns None for records that should be skipped.

    Differences (audit -> transcript):
      * ``session_id`` (snake_case) -> ``sessionId``
      * ``_audit_timestamp`` -> ``timestamp`` (when no transcript timestamp)
      * ``type=system`` (subtype=init/status/etc.) -> dropped (no convo content)
      * ``parent_tool_use_id`` left as-is; flatten() does not require parentUuid
    """
    t = obj.get("type")
    if t == "system":
        return None
    if "session_id" in obj and "sessionId" not in obj:
        obj["sessionId"] = obj.pop("session_id")
    if "timestamp" not in obj and "_audit_timestamp" in obj:
        obj["timestamp"] = obj.get("_audit_timestamp", "")
    return obj


def _audit_record_signature(obj: dict[str, Any]) -> tuple | None:
    """Build a hashable dedup signature for an audit.jsonl record. Returns
    None to opt out of dedup for that record (e.g. records with no
    user-facing content).

    Cowork on Windows emits each user prompt twice — and sometimes with a
    different uuid plus an intervening attachment block — so the simple
    (uuid, kind) / adjacent-text dedup in flatten() is not enough. We dedup
    at record-load time by (type, role, content_signature) so spurious
    repeats are dropped before they ever reach the flat list."""
    msg = obj.get("message")
    if not isinstance(msg, dict):
        return None
    role = msg.get("role")
    t = obj.get("type")
    content = msg.get("content")
    if isinstance(content, str):
        text = content.strip()
        if not text:
            return None
        return ("text", t, role, text)
    if isinstance(content, list):
        # Pick a stable signature from the first non-trivial block.
        for block in content:
            if not isinstance(block, dict):
                continue
            bt = block.get("type")
            if bt == "text":
                text = (block.get("text", "") or "").strip()
                if text:
                    return ("text", t, role, text)
            elif bt == "tool_use":
                return (
                    "tool_use",
                    block.get("id", ""),
                    block.get("name", ""),
                    json.dumps(block.get("input"), ensure_ascii=False, sort_keys=True),
                )
            elif bt == "tool_result":
                inner = block.get("content")
                if isinstance(inner, str):
                    inner_sig = inner[:400]
                elif isinstance(inner, list):
                    inner_sig = json.dumps(inner, ensure_ascii=False)[:400]
                else:
                    inner_sig = ""
                return ("tool_result", block.get("tool_use_id", ""), inner_sig)
            elif bt == "thinking":
                text = (block.get("thinking", "") or "").strip()
                if text:
                    return ("thinking", t, text[:400])
    return None


def load_transcript(jsonl_path: Path) -> tuple[SessionMeta, list[dict[str, Any]]]:
    meta = SessionMeta()
    raw: list[dict[str, Any]] = []
    is_audit = jsonl_path.name == "audit.jsonl"
    seen_audit_sigs: set[tuple] = set()
    with jsonl_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if is_audit:
                obj = _normalize_audit_record(obj)
                if obj is None:
                    continue
                sig = _audit_record_signature(obj)
                if sig is not None:
                    if sig in seen_audit_sigs:
                        continue
                    seen_audit_sigs.add(sig)
            raw.append(obj)
            if not meta.cli_session_id and obj.get("sessionId"):
                meta.cli_session_id = obj["sessionId"]
            if obj.get("cwd"):
                meta.cwd = obj["cwd"]
            if obj.get("gitBranch"):
                meta.git_branch = obj["gitBranch"]
            if obj.get("version"):
                meta.version = obj["version"]
            if obj.get("entrypoint"):
                meta.entrypoint = obj["entrypoint"]
            if obj.get("permissionMode"):
                meta.permission_mode = obj["permissionMode"]
            ts = obj.get("timestamp")
            if ts:
                if not meta.started_at:
                    meta.started_at = ts
                meta.ended_at = ts
            if obj.get("type") == "ai-title" and obj.get("aiTitle"):
                meta.title = obj["aiTitle"]
    return meta, raw


def merge_task_meta(meta: SessionMeta, task: Task) -> None:
    meta.source = task.source
    meta.task_id = task.task_id
    if task.title:
        meta.title = task.title
    if task.model:
        meta.model = task.model
    if task.initial_message:
        meta.initial_message = task.initial_message
    if task.cwd and not meta.cwd:
        meta.cwd = task.cwd
    meta.user_folders = list(task.user_folders)
    meta.archived = task.archived
    meta.error = task.error
    meta.space_name = task.space_name
    if not meta.started_at and task.created_at_ms:
        meta.started_at = datetime.fromtimestamp(task.created_at_ms / 1000, tz=timezone.utc).isoformat()
    if task.last_activity_ms:
        meta.ended_at = datetime.fromtimestamp(task.last_activity_ms / 1000, tz=timezone.utc).isoformat()


def flatten(raw: list[dict[str, Any]]) -> list[FlatMessage]:
    flat: list[FlatMessage] = []
    seen_uuid_kind: set[tuple[str, str]] = set()
    last_text_signature: tuple[str, str, str] | None = None

    def push(**kwargs):
        # Drop duplicates that appear as the same (uuid, kind) — Cowork's
        # audit.jsonl on Windows emits each user prompt twice (once before
        # and once after the dispatch handshake) and the duplicate carries
        # the same uuid as the original.
        u = kwargs.get("uuid") or ""
        k = kwargs.get("kind") or ""
        if u and (u, k) in seen_uuid_kind:
            return
        # Also drop adjacent identical text blocks (same role + text) when
        # uuid is missing or differs slightly between the two copies.
        nonlocal last_text_signature
        if k == "text":
            sig = (kwargs.get("role", ""), k, kwargs.get("text", "") or "")
            if sig[2] and sig == last_text_signature:
                return
            last_text_signature = sig
        else:
            last_text_signature = None
        if u:
            seen_uuid_kind.add((u, k))
        flat.append(FlatMessage(index=len(flat), **kwargs))

    for obj in raw:
        t = obj.get("type")
        if t in ("queue-operation", "ai-title", "last-prompt"):
            continue
        ts = obj.get("timestamp", "") or ""
        uuid = obj.get("uuid", "") or ""
        parent = obj.get("parentUuid", "") or ""
        if t == "attachment":
            att = obj.get("attachment", {}) or {}
            push(kind="attachment", role="system", timestamp=ts, uuid=uuid, parent_uuid=parent,
                 attachment_type=att.get("type", ""), attachment_payload=att)
            continue
        msg = obj.get("message") or {}
        role = msg.get("role", "?")
        content = msg.get("content")
        if isinstance(content, str):
            push(kind="text", role=role, timestamp=ts, uuid=uuid, parent_uuid=parent, text=content)
            continue
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            bt = block.get("type")
            if bt == "text":
                push(kind="text", role=role, timestamp=ts, uuid=uuid, parent_uuid=parent, text=block.get("text", ""))
            elif bt == "thinking":
                push(kind="thinking", role=role, timestamp=ts, uuid=uuid, parent_uuid=parent, text=block.get("thinking", ""))
            elif bt == "tool_use":
                push(kind="tool_use", role=role, timestamp=ts, uuid=uuid, parent_uuid=parent,
                     tool_name=block.get("name", ""), tool_id=block.get("id", ""),
                     tool_input=block.get("input"))
            elif bt == "tool_result":
                inner = block.get("content")
                text = ""
                if isinstance(inner, str):
                    text = inner
                elif isinstance(inner, list):
                    parts: list[str] = []
                    for x in inner:
                        if isinstance(x, dict):
                            if x.get("type") == "text":
                                parts.append(x.get("text", ""))
                            elif x.get("type") == "image":
                                parts.append("[image]")
                    text = "\n".join(parts)
                tur = obj.get("toolUseResult") or {}
                tur_meta = (
                    {k: v for k, v in tur.items() if k not in ("stdout", "stderr")}
                    if isinstance(tur, dict)
                    else {}
                )
                stderr = tur.get("stderr") if isinstance(tur, dict) else None
                extra = {}
                if stderr:
                    extra["stderr"] = stderr
                if tur_meta:
                    extra["result_meta"] = tur_meta
                push(kind="tool_result", role=role, timestamp=ts, uuid=uuid, parent_uuid=parent,
                     text=text, tool_id=block.get("tool_use_id", ""),
                     is_error=bool(block.get("is_error")), extra=extra)
            elif bt == "image":
                push(kind="image", role=role, timestamp=ts, uuid=uuid, parent_uuid=parent,
                     extra={"source": block.get("source")})
            else:
                push(kind=bt or "unknown", role=role, timestamp=ts, uuid=uuid, parent_uuid=parent,
                     extra={"raw": block})
    return flat


# ---------------------------------------------------------------------------
# Touched files (Write / Edit / NotebookEdit / MultiEdit)
# ---------------------------------------------------------------------------

@dataclass
class TouchedFile:
    absolute_path: str
    relative_path: str
    op: str
    message_uuid: str
    exists: bool = False
    size: int = 0
    recorded_content: str | None = None
    edit_only: bool = False

    def to_dict(self) -> dict[str, Any]:
        d = self.__dict__.copy()
        d.pop("recorded_content", None)
        d["has_recorded_content"] = self.recorded_content is not None
        return d


def collect_touched_files(flat: list[FlatMessage], cwd: str) -> list[TouchedFile]:
    cwd_p = Path(cwd).resolve() if cwd else None
    seen: dict[str, TouchedFile] = {}
    for m in flat:
        if m.kind != "tool_use":
            continue
        inp = m.tool_input or {}
        if not isinstance(inp, dict):
            continue
        path: str | None = None
        op = m.tool_name
        if m.tool_name in ("Write", "Edit", "MultiEdit"):
            path = inp.get("file_path")
        elif m.tool_name == "NotebookEdit":
            path = inp.get("notebook_path")
        if not path:
            continue
        try:
            abs_p = Path(path).resolve()
        except OSError:
            continue
        rel = ""
        if cwd_p:
            r = _rel_to(abs_p, cwd_p)
            if r is not None:
                rel = r
        key = os.path.normcase(str(abs_p)) if sys.platform == "win32" else str(abs_p)
        tf = seen.get(key)
        if tf is None:
            tf = TouchedFile(absolute_path=str(abs_p), relative_path=rel, op=op, message_uuid=m.uuid)
            seen[key] = tf
        elif op not in tf.op.split("+"):
            tf.op = f"{tf.op}+{op}"
        if m.tool_name == "Write":
            content = inp.get("content")
            if isinstance(content, str):
                tf.recorded_content = content
    out = list(seen.values())
    for tf in out:
        p = Path(tf.absolute_path)
        try:
            if p.exists() and p.is_file():
                tf.exists = True
                tf.size = p.stat().st_size
        except OSError:
            tf.exists = False
        tf.edit_only = (tf.recorded_content is None) and ("Write" not in tf.op.split("+"))
    return out


def list_dir_files(d: Path) -> list[Path]:
    if not d.exists() or not d.is_dir():
        return []
    out = []
    for p in d.rglob("*"):
        if p.is_file() and not p.name.startswith("."):
            out.append(p)
    return out


# ---------------------------------------------------------------------------
# Renderers
# ---------------------------------------------------------------------------

def _fmt_ts(ts: str) -> str:
    if not ts:
        return ""
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        return ts


def _human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{n}{unit}"
        n /= 1024
    return f"{n:.1f}GB"


def render_markdown(
    meta: SessionMeta,
    flat: list[FlatMessage],
    touched: list[TouchedFile],
    uploads: list[Path],
    outputs: list[Path],
    bundle_root: Path,
) -> str:
    out: list[str] = []
    title = meta.title or f"Cowork task {meta.task_id[:8]}"
    out.append(f"# {title}")
    out.append("")
    info = [
        ("Source", meta.source),
        ("Task ID", meta.task_id),
        ("CLI session", meta.cli_session_id),
        ("Space", meta.space_name),
        ("Model", meta.model),
        ("Working dir", meta.cwd),
        ("User folders", ", ".join(meta.user_folders) if meta.user_folders else ""),
        ("Started", _fmt_ts(meta.started_at)),
        ("Ended", _fmt_ts(meta.ended_at)),
        ("Archived", "yes" if meta.archived else ""),
        ("Error", meta.error),
        ("Git branch", meta.git_branch),
        ("Claude Code", meta.version),
    ]
    for label, value in info:
        if value:
            out.append(f"- **{label}:** `{value}`" if label in ("Task ID", "CLI session", "Working dir", "Git branch", "Claude Code") else f"- **{label}:** {value}")
    out.append("")

    if meta.initial_message:
        out.append("## Initial message")
        out.append("")
        out.append("> " + meta.initial_message.strip().replace("\n", "\n> "))
        out.append("")

    if uploads:
        out.append(f"## Uploads ({len(uploads)})")
        out.append("")
        for p in uploads:
            try:
                rel = p.relative_to(bundle_root)
            except ValueError:
                rel = Path("uploads") / p.name
            out.append(f"- [{p.name}]({rel}) — {_human_size(p.stat().st_size)}")
        out.append("")

    if outputs:
        out.append(f"## Outputs ({len(outputs)})")
        out.append("")
        for p in outputs:
            try:
                rel = p.relative_to(bundle_root)
            except ValueError:
                rel = Path("outputs") / p.name
            out.append(f"- [{p.name}]({rel}) — {_human_size(p.stat().st_size)}")
        out.append("")

    if touched:
        out.append("## Files written / edited via tool calls")
        out.append("")
        for tf in touched:
            shown = tf.relative_path or tf.absolute_path
            link = f"[{shown}](assets/{tf.relative_path})" if tf.exists and tf.relative_path else shown
            status = "" if tf.exists else " _(not on disk anymore)_"
            out.append(f"- `{tf.op}` — {link}{status}")
        out.append("")

    out.append("## Transcript")
    out.append("")
    for m in flat:
        ts = _fmt_ts(m.timestamp)
        if m.kind == "text":
            who = m.role.capitalize()
            out.append(f"### {who} · {ts}")
            out.append("")
            out.append(_strip_uploaded_files_wrapper(m.text).rstrip() or "_(empty)_")
            out.append("")
        elif m.kind == "thinking":
            out.append(f"<details><summary>Thinking · {ts}</summary>")
            out.append("")
            out.append(m.text.rstrip())
            out.append("")
            out.append("</details>")
            out.append("")
        elif m.kind == "tool_use":
            inp = json.dumps(m.tool_input, ensure_ascii=False, indent=2) if m.tool_input is not None else ""
            out.append(f"#### Tool call: `{m.tool_name}` · {ts}")
            out.append("")
            out.append("```json")
            out.append(inp)
            out.append("```")
            out.append("")
        elif m.kind == "tool_result":
            tag = "Tool error" if m.is_error else "Tool result"
            out.append(f"<details><summary>{tag} · {ts}</summary>")
            out.append("")
            txt = m.text or ""
            note = ""
            if len(txt) > TOOL_RESULT_TRUNCATE:
                note = f"\n\n_…truncated, full text in JSON export ({len(txt)} chars)_"
                txt = txt[:TOOL_RESULT_TRUNCATE]
            out.append("```")
            out.append(txt.rstrip())
            out.append("```")
            if note:
                out.append(note)
            out.append("")
            out.append("</details>")
            out.append("")
        elif m.kind == "attachment":
            payload = m.attachment_payload or {}
            preview = json.dumps({k: v for k, v in payload.items() if k != "type"}, ensure_ascii=False)[:400]
            out.append(f"<details><summary>attachment · {m.attachment_type} · {ts}</summary>")
            out.append("")
            out.append("```json")
            out.append(preview)
            out.append("```")
            out.append("")
            out.append("</details>")
            out.append("")
        elif m.kind == "image":
            out.append(f"_(image attachment · {ts})_")
            out.append("")
        else:
            out.append(f"_({m.kind} · {ts})_")
            out.append("")
    return "\n".join(out)


def _strip_uploaded_files_wrapper(text: str) -> str:
    if not text or "<uploaded_files>" not in text:
        return text
    start = text.find("<uploaded_files>")
    end = text.find("</uploaded_files>")
    if start == -1 or end == -1:
        return text
    return (text[:start] + text[end + len("</uploaded_files>"):]).strip()


HTML_TEMPLATE = """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>{title}</title>
<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/styles/github.min.css">
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js"></script>
<style>
:root {{
  --bg: #fafafa; --fg: #1f2328; --muted: #656d76; --border: #d0d7de;
  --user-bg: #ddf4ff; --user-bd: #b6e3ff;
  --asst-bg: #ffffff; --asst-bd: #d0d7de;
  --tool-bg: #fff8c5; --tool-bd: #eac54f;
  --result-bg: #dafbe1; --result-bd: #4ac26b;
  --result-err-bg: #ffebe9; --result-err-bd: #ff8182;
  --thinking-bg: #f3e8ff; --thinking-bd: #c8a2f5;
  --att-bg: #f6f8fa; --att-bd: #d0d7de;
  --code-bg: #0d1117; --code-fg: #e6edf3;
}}
* {{ box-sizing: border-box; }}
html, body {{ margin: 0; padding: 0; }}
body {{
  font: 15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
        "Helvetica Neue", Arial, sans-serif;
  color: var(--fg); background: var(--bg);
}}
.wrap {{ max-width: 1080px; margin: 32px auto; padding: 0 20px; }}
header.head {{
  background: #fff; border: 1px solid var(--border); border-radius: 10px;
  padding: 20px 24px; margin-bottom: 24px;
}}
header.head h1 {{ margin: 0 0 12px; font-size: 22px; }}
header.head dl {{
  display: grid; grid-template-columns: max-content 1fr;
  gap: 4px 16px; margin: 0; font-size: 13px; color: var(--muted);
}}
header.head dt {{ font-weight: 600; color: var(--fg); }}
header.head dd {{ margin: 0; word-break: break-all; }}
header.head dd.mono {{ font-family: ui-monospace, Menlo, Consolas, monospace; }}
header.head .err {{ color: #cf222e; }}
.initial {{
  background: #fff; border: 1px solid var(--border); border-radius: 10px;
  padding: 14px 20px; margin-bottom: 24px;
}}
.initial h2 {{ margin: 0 0 8px; font-size: 14px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }}
.initial blockquote {{ margin: 0; padding-left: 12px; border-left: 3px solid var(--border); color: var(--fg); white-space: pre-wrap; font-size: 14px; }}
.section {{
  background: #fff; border: 1px solid var(--border); border-radius: 10px;
  padding: 14px 20px; margin-bottom: 24px;
}}
.section h2 {{ margin: 0 0 10px; font-size: 15px; }}
.section ul {{ margin: 0; padding-left: 22px; font-size: 13px; }}
.section li {{ margin: 3px 0; font-family: ui-monospace, Menlo, Consolas, monospace; }}
.section .op {{
  display: inline-block; padding: 1px 6px; margin-right: 6px;
  border-radius: 4px; background: #eee; font-size: 11px;
}}
.section .size {{ color: var(--muted); font-size: 12px; margin-left: 6px; }}
.toc {{
  background: #fff; border: 1px solid var(--border); border-radius: 10px;
  padding: 12px 20px 14px; margin-bottom: 24px;
}}
.toc h2 {{ margin: 0 0 8px; font-size: 14px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }}
.toc ol {{ margin: 0; padding-left: 22px; font-size: 13px; }}
.toc a {{ color: #0969da; text-decoration: none; }}
.toc a:hover {{ text-decoration: underline; }}
section.turn {{
  border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px;
  margin-bottom: 22px; background: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,0.04);
}}
section.turn .turn-head {{
  display: flex; align-items: baseline; gap: 12px;
  font-size: 12px; color: var(--muted);
  border-bottom: 1px dashed var(--border); padding-bottom: 8px; margin-bottom: 14px;
}}
section.turn .turn-num {{
  font-weight: 700; color: var(--fg); padding: 2px 8px;
  background: rgba(9,105,218,0.08); border-radius: 999px; font-size: 11px;
}}
section.turn .turn-preview {{
  flex: 1 1 auto; color: var(--fg); font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}}
section.turn .turn-ts {{ flex: 0 0 auto; font-variant-numeric: tabular-nums; }}
section.turn .msg {{ margin-bottom: 12px; }}
section.turn .msg:last-child {{ margin-bottom: 0; }}
details.process {{
  border: 1px solid var(--border); border-radius: 8px;
  padding: 10px 14px; margin: 8px 0 14px;
  background: rgba(0,0,0,0.02);
}}
details.process > summary {{ font-weight: 600; color: var(--muted); }}
details.process[open] > summary {{ color: var(--fg); }}
details.process .process-meta {{ font-weight: 400; color: var(--muted); margin-left: 4px; }}
details.process > .msg {{ margin-top: 10px; }}
details.preamble {{
  border: 1px dashed var(--border); border-radius: 8px;
  padding: 10px 14px; margin-bottom: 18px; color: var(--muted);
}}
.msg {{
  border: 1px solid; border-radius: 10px; padding: 14px 18px;
  margin-bottom: 16px; background: #fff; overflow: hidden;
}}
.msg.user {{ background: var(--user-bg); border-color: var(--user-bd); }}
.msg.assistant {{ background: var(--asst-bg); border-color: var(--asst-bd); }}
.msg.thinking {{ background: var(--thinking-bg); border-color: var(--thinking-bd); border-style: dashed; }}
.msg.tool_use {{ background: var(--tool-bg); border-color: var(--tool-bd); }}
.msg.tool_result {{ background: var(--result-bg); border-color: var(--result-bd); }}
.msg.tool_result.error {{ background: var(--result-err-bg); border-color: var(--result-err-bd); }}
.msg.attachment, .msg.image, .msg.unknown {{
  background: var(--att-bg); border-color: var(--att-bd);
  color: var(--muted); font-size: 13px;
}}
.msg-head {{
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 10px; font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--muted);
}}
.msg-head .role {{ font-weight: 700; }}
.msg-body {{ font-size: 15px; }}
.msg-body > *:first-child {{ margin-top: 0; }}
.msg-body > *:last-child {{ margin-bottom: 0; }}
.md p, .md ul, .md ol, .md blockquote {{ margin: 0.5em 0; }}
.md h1, .md h2, .md h3, .md h4 {{ margin: 0.6em 0 0.3em; }}
.md ul, .md ol {{ padding-left: 1.6em; }}
.md blockquote {{ border-left: 3px solid var(--border); padding: 0 12px; color: var(--muted); margin-left: 0; }}
.md pre {{
  background: var(--code-bg); color: var(--code-fg);
  padding: 12px 14px; border-radius: 6px; overflow-x: auto;
  max-height: 520px; margin: 0.5em 0;
}}
.md pre code {{ background: transparent; padding: 0; color: inherit; }}
.md :not(pre) > code {{ background: rgba(175,184,193,0.2); padding: 1px 5px; border-radius: 4px; font-size: 0.9em; }}
.md table {{ border-collapse: collapse; margin: 0.6em 0; max-width: 100%; display: block; overflow-x: auto; }}
.md th, .md td {{ border: 1px solid var(--border); padding: 4px 8px; }}
.md th {{ background: #f6f8fa; }}
.md img {{ max-width: 100%; height: auto; }}
code, pre {{ font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }}
details {{ margin: 6px 0; }}
details > summary {{ cursor: pointer; color: #444; font-weight: 600; user-select: none; }}
details[open] > summary {{ margin-bottom: 8px; }}
.tool-name {{
  display: inline-block; padding: 2px 8px; border-radius: 4px;
  background: rgba(0,0,0,0.08); font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: 13px;
}}
.truncated {{ color: var(--muted); font-style: italic; font-size: 12px; margin-top: 6px; }}
pre.raw {{
  background: var(--code-bg); color: var(--code-fg);
  padding: 12px 14px; border-radius: 6px; overflow-x: auto;
  max-height: 520px; margin: 0; white-space: pre-wrap; word-break: break-word;
}}
@media (prefers-color-scheme: dark) {{
  :root {{
    --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e; --border: #30363d;
    --user-bg: #0c2d6b; --user-bd: #1f6feb;
    --asst-bg: #161b22; --asst-bd: #30363d;
    --tool-bg: #3d2e00; --tool-bd: #8b6914;
    --result-bg: #04260f; --result-bd: #2ea043;
    --result-err-bg: #3d0e0e; --result-err-bd: #f85149;
    --thinking-bg: #2d1b4e; --thinking-bd: #8957e5;
    --att-bg: #161b22; --att-bd: #30363d;
  }}
  body {{ background: var(--bg); }}
  header.head, .initial, .section, .toc, section.turn {{ background: #161b22; }}
  section.turn .turn-num {{ background: rgba(88,166,255,0.18); }}
  details.process {{ background: rgba(255,255,255,0.03); }}
  .md th {{ background: #161b22; }}
  .md :not(pre) > code {{ background: rgba(110,118,129,0.4); }}
  .toc a {{ color: #58a6ff; }}
}}
</style>
</head>
<body>
<div class="wrap">
{header}
{initial}
{uploads}
{outputs}
{touched}
{toc}
{messages}
</div>
<script>
(function () {{
  const opts = {{ gfm: true, breaks: true, headerIds: false, mangle: false }};
  if (window.marked && marked.setOptions) marked.setOptions(opts);
  document.querySelectorAll('.md').forEach(el => {{
    const raw = el.textContent;
    el.innerHTML = window.marked ? marked.parse(raw, opts) : raw;
  }});
  if (window.hljs) {{
    document.querySelectorAll('pre code').forEach(el => {{
      try {{ hljs.highlightElement(el); }} catch (e) {{}}
    }});
  }}
}})();
</script>
</body>
</html>
"""


def render_html(
    meta: SessionMeta,
    flat: list[FlatMessage],
    touched: list[TouchedFile],
    uploads: list[Path],
    outputs: list[Path],
    bundle_root: Path,
) -> str:
    esc = html_mod.escape
    title = meta.title or f"Cowork task {meta.task_id[:8]}"

    rows: list[tuple[str, str, bool]] = [
        ("Source", meta.source, False),
        ("Task ID", meta.task_id, True),
        ("CLI session", meta.cli_session_id, True),
        ("Space", meta.space_name, False),
        ("Model", meta.model, False),
        ("Working dir", meta.cwd, True),
        ("User folders", ", ".join(meta.user_folders), True),
        ("Started", _fmt_ts(meta.started_at), False),
        ("Ended", _fmt_ts(meta.ended_at), False),
        ("Archived", "yes" if meta.archived else "", False),
        ("Error", meta.error, False),
        ("Git branch", meta.git_branch, True),
        ("Claude Code", meta.version, True),
    ]
    head_parts = [f"<header class='head'><h1>{esc(title)}</h1><dl>"]
    for label, value, mono in rows:
        if not value:
            continue
        cls = " class='mono'" if mono else ""
        if label == "Error":
            cls = " class='err'"
        head_parts.append(f"<dt>{esc(label)}</dt><dd{cls}>{esc(str(value))}</dd>")
    head_parts.append("</dl></header>")

    initial_html = ""
    if meta.initial_message:
        initial_html = (
            "<div class='initial'><h2>Initial message</h2>"
            f"<blockquote>{esc(meta.initial_message)}</blockquote></div>"
        )

    def _file_section(label: str, paths: list[Path]) -> str:
        if not paths:
            return ""
        items = []
        for p in paths:
            try:
                rel = p.relative_to(bundle_root)
            except ValueError:
                continue
            href = "/".join(html_mod.escape(seg, quote=True) for seg in rel.parts)
            size = _human_size(p.stat().st_size) if p.exists() else ""
            items.append(
                f"<li><a href=\"{href}\">{esc(p.name)}</a>"
                f"<span class='size'>{esc(size)}</span></li>"
            )
        return f"<div class='section'><h2>{esc(label)} ({len(paths)})</h2><ul>{''.join(items)}</ul></div>"

    uploads_html = _file_section("Uploads", uploads)
    outputs_html = _file_section("Outputs", outputs)

    touched_html = ""
    if touched:
        items = []
        for tf in touched:
            shown = esc(tf.relative_path or tf.absolute_path)
            if tf.exists and tf.relative_path:
                href = "assets/" + "/".join(html_mod.escape(seg, quote=True) for seg in tf.relative_path.split("/"))
                link = f"<a href=\"{href}\">{shown}</a>"
            else:
                link = shown
            status = "" if tf.exists else " <em>(not on disk anymore)</em>"
            items.append(f"<li><span class='op'>{esc(tf.op)}</span>{link}{status}</li>")
        touched_html = (
            "<div class='section'><h2>Files written / edited via tool calls</h2>"
            f"<ul>{''.join(items)}</ul></div>"
        )

    preamble, turns = _split_into_turns(flat)

    toc_items = []
    for i, turn in enumerate(turns):
        u = turn["user"]
        preview_src = _strip_uploaded_files_wrapper(u.text).strip().splitlines()
        preview = preview_src[0] if preview_src else "(empty)"
        preview = preview[:80] + ("…" if len(preview) > 80 else "")
        toc_items.append(f"<li><a href=\"#t{i}\">{esc(preview)}</a></li>")
    toc_html = ""
    if toc_items:
        toc_html = f"<div class='toc'><h2>User prompts</h2><ol>{''.join(toc_items)}</ol></div>"

    parts: list[str] = []

    if preamble:
        intro_pieces = [_render_block_html(m, esc) for m in preamble if _render_block_html(m, esc)]
        if intro_pieces:
            parts.append(
                "<details class='preamble'><summary>Pre-conversation events "
                f"({len(intro_pieces)})</summary>{''.join(intro_pieces)}</details>"
            )

    for i, turn in enumerate(turns):
        u: FlatMessage = turn["user"]
        body: list[FlatMessage] = turn["body"]
        hidden = [m for m in body if m.kind in ("thinking", "tool_use", "tool_result", "attachment", "image", "unknown")]
        visible_text = [m for m in body if m.kind == "text"]

        ts = esc(_fmt_ts(u.timestamp))
        user_text = _strip_uploaded_files_wrapper(u.text)
        prompt_preview = (user_text.strip().splitlines()[0] if user_text.strip() else "(empty)")
        prompt_preview = prompt_preview[:120] + ("…" if len(prompt_preview) > 120 else "")

        n_tool = sum(1 for m in hidden if m.kind == "tool_use")
        n_think = sum(1 for m in hidden if m.kind == "thinking")
        process_summary_bits = []
        if n_think:
            process_summary_bits.append(f"{n_think} thinking")
        if n_tool:
            process_summary_bits.append(f"{n_tool} tool call{'s' if n_tool != 1 else ''}")
        n_other = len(hidden) - n_tool - n_think
        if n_other > 0:
            process_summary_bits.append(f"{n_other} other")
        process_summary = " · ".join(process_summary_bits) if process_summary_bits else "no internal steps"

        parts.append(f"<section class='turn' id='t{i}'>")
        parts.append(
            f"<div class='turn-head'><span class='turn-num'>#{i + 1}</span>"
            f"<span class='turn-preview'>{esc(prompt_preview)}</span>"
            f"<span class='turn-ts'>{ts}</span></div>"
        )
        # User prompt: visible
        parts.append(
            f"<div class='msg user'><div class='msg-head'><span class='role'>User</span>"
            f"<span>{ts}</span></div><div class='msg-body'><div class='md'>{esc(user_text)}</div></div></div>"
        )
        # Process: hidden by default
        if hidden:
            inner = "".join(_render_block_html(m, esc) for m in hidden)
            parts.append(
                f"<details class='process'><summary>Assistant reasoning &amp; tool calls "
                f"<span class='process-meta'>· {esc(process_summary)}</span></summary>{inner}</details>"
            )
        # Visible assistant text(s)
        for m in visible_text:
            parts.append(_render_block_html(m, esc))
        parts.append("</section>")

    return HTML_TEMPLATE.format(
        title=esc(title),
        header="".join(head_parts),
        initial=initial_html,
        uploads=uploads_html,
        outputs=outputs_html,
        touched=touched_html,
        toc=toc_html,
        messages="".join(parts),
    )


def _split_into_turns(flat: list[FlatMessage]) -> tuple[list[FlatMessage], list[dict[str, Any]]]:
    """Partition flat messages into a preamble (everything before the first
    user-text) plus a list of conversation turns. A turn opens at a user-text
    block and runs through every following block up to the next user-text."""
    preamble: list[FlatMessage] = []
    turns: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    for m in flat:
        if m.kind == "text" and m.role == "user":
            if current is not None:
                turns.append(current)
            current = {"user": m, "body": []}
        elif current is None:
            preamble.append(m)
        else:
            current["body"].append(m)
    if current is not None:
        turns.append(current)
    return preamble, turns


def _render_block_html(m: FlatMessage, esc) -> str:
    ts = esc(_fmt_ts(m.timestamp))
    anchor = f"m{m.index}"
    if m.kind == "text":
        klass = "user" if m.role == "user" else "assistant"
        label = m.role.capitalize()
        text = _strip_uploaded_files_wrapper(m.text)
        body = f"<div class='md'>{esc(text)}</div>"
        return _msg_html(anchor, klass, label, ts, body)
    if m.kind == "thinking":
        body = f"<details open><summary>Reasoning</summary><div class='md'>{esc(m.text)}</div></details>"
        return _msg_html(anchor, "thinking", "thinking", ts, body)
    if m.kind == "tool_use":
        tn = esc(m.tool_name)
        inp = json.dumps(m.tool_input, ensure_ascii=False, indent=2) if m.tool_input is not None else ""
        body = (
            f"<div><span class='tool-name'>{tn}</span></div>"
            f"<details><summary>Input</summary>"
            f"<pre><code class='language-json'>{esc(inp)}</code></pre></details>"
        )
        return _msg_html(anchor, "tool_use", "tool call", ts, body)
    if m.kind == "tool_result":
        klass = "tool_result error" if m.is_error else "tool_result"
        label = "tool error" if m.is_error else "tool result"
        txt = m.text or ""
        note = ""
        if len(txt) > TOOL_RESULT_TRUNCATE:
            note = (
                f"<div class='truncated'>…truncated, full text in JSON export "
                f"({len(txt)} chars)</div>"
            )
            txt = txt[:TOOL_RESULT_TRUNCATE]
        body = f"<details open><summary>Output</summary><pre class='raw'>{esc(txt)}</pre>{note}</details>"
        return _msg_html(anchor, klass, label, ts, body)
    if m.kind == "attachment":
        atype = esc(m.attachment_type)
        payload = m.attachment_payload or {}
        preview = json.dumps({k: v for k, v in payload.items() if k != "type"}, ensure_ascii=False)
        if len(preview) > 600:
            preview = preview[:600] + " …"
        body = f"<details><summary>attachment · {atype}</summary><pre class='raw'>{esc(preview)}</pre></details>"
        return _msg_html(anchor, "attachment", "attachment", ts, body)
    if m.kind == "image":
        return _msg_html(anchor, "image", "image", ts, "<em>(image attachment)</em>")
    return _msg_html(anchor, "unknown", esc(m.kind), ts, "<em>unhandled block</em>")


def _msg_html(anchor: str, klass: str, label: str, ts: str, body: str) -> str:
    return (
        f"<div class='msg {klass}' id='{anchor}'>"
        f"<div class='msg-head'><span class='role'>{label}</span><span>{ts}</span></div>"
        f"<div class='msg-body'>{body}</div></div>"
    )


def render_json(
    meta: SessionMeta,
    flat: list[FlatMessage],
    touched: list[TouchedFile],
    uploads: list[Path],
    outputs: list[Path],
    bundle_root: Path,
) -> str:
    def file_entry(p: Path) -> dict[str, Any]:
        try:
            rel = str(p.relative_to(bundle_root))
        except ValueError:
            rel = p.name
        return {
            "name": p.name,
            "relative_path": rel,
            "size": p.stat().st_size if p.exists() else 0,
        }

    payload = {
        "meta": meta.to_dict(),
        "uploads": [file_entry(p) for p in uploads],
        "outputs": [file_entry(p) for p in outputs],
        "files": [tf.to_dict() for tf in touched],
        "messages": [m.to_dict() for m in flat],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


def write_csv(path: Path, flat: list[FlatMessage]) -> None:
    cols = [
        "index", "timestamp", "role", "kind",
        "tool_name", "tool_id", "is_error",
        "preview", "content", "tool_input_json",
        "uuid", "parent_uuid",
    ]
    with path.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for m in flat:
            content = m.text
            if m.kind == "tool_use":
                content = json.dumps(m.tool_input, ensure_ascii=False) if m.tool_input is not None else ""
            elif m.kind == "attachment":
                content = json.dumps(m.attachment_payload, ensure_ascii=False) if m.attachment_payload is not None else ""
            preview_src = m.text if m.kind != "tool_use" else (m.tool_name or "")
            preview = (preview_src or "").strip().replace("\n", " ")[:200]
            w.writerow([
                m.index, m.timestamp, m.role, m.kind,
                m.tool_name, m.tool_id, "1" if m.is_error else "",
                preview, content,
                json.dumps(m.tool_input, ensure_ascii=False) if m.tool_input is not None else "",
                m.uuid, m.parent_uuid,
            ])


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------

def _cowork_userdata_root() -> Path:
    """The Cowork desktop user-data dir, parent of local-agent-mode-sessions.
    Auth artefacts live alongside (Cookies / Local State / etc.)."""
    if sys.platform == "darwin":
        return HOME / "Library" / "Application Support" / "Claude"
    if sys.platform == "win32":
        appdata = os.environ.get("APPDATA")
        base = Path(appdata) if appdata else (HOME / "AppData" / "Roaming")
        return base / "Claude"
    return HOME / ".config" / "Claude"


def _confirm_auth_risk(non_interactive_ack: bool) -> None:
    msg = textwrap.dedent("""\
        ⚠️  --include-auth requested.
            The exported bundle will contain Cowork desktop's auth artefacts.
            Anyone who obtains this bundle can act as your account until you
            rotate (log out everywhere / change password / revoke device).

            Cross-platform note: most of these artefacts are encrypted with the
            source platform's keystore (macOS Keychain / Windows DPAPI). They
            CANNOT be migrated across platforms — import on a different OS will
            refuse to install them and you'll have to sign in normally.

            Intended uses:
              - migrating your own Cowork setup to a same-OS device you control
              - personal backup stored in an encrypted vault

            Do NOT:
              - share this bundle with anyone
              - upload to unencrypted cloud storage / chat / email
        """)
    print(msg, file=sys.stderr)
    if non_interactive_ack:
        print("  ack: --yes-i-know-this-is-risky given; proceeding non-interactively.",
              file=sys.stderr)
        return
    try:
        ans = input('Type "I UNDERSTAND" to proceed: ').strip()
    except EOFError:
        ans = ""
    if ans != "I UNDERSTAND":
        print("  abort: confirmation phrase not received.", file=sys.stderr)
        raise SystemExit(3)


def _resolve_auth_sources() -> list[Path]:
    """Locate every Cowork auth artefact present on this host."""
    root = _cowork_userdata_root()
    found: list[Path] = []
    for rel in COWORK_AUTH_RELATIVE:
        p = root / rel
        if p.exists():
            found.append(p)
    return found


def _bundle_is_complete(target: Path) -> bool:
    """A bundle is safe to purge against only if its lossless core is on disk
    and non-empty: transcript.jsonl + manifest.json."""
    for name in ("transcript.jsonl", "manifest.json"):
        p = target / name
        try:
            if not p.is_file() or p.stat().st_size == 0:
                return False
        except OSError:
            return False
    return True


def _cowork_task_purge_targets(task: Task) -> list[Path]:
    """Every on-disk path that constitutes a Cowork task's local footprint,
    across ALL discovered roots (Windows MSIX keeps a copy in both
    %APPDATA% and %LOCALAPPDATA%\\Packages\\...).

    Returns the task sandbox dir (`local_<id>/`, which holds the transcript,
    uploads, outputs, audit.jsonl) plus its `local_<id>.json` metadata
    sibling, for every workspace where the task id appears. Deliberately
    excludes spaces.json, sibling tasks, and the external userSelectedFolders
    (the user's real project files) — those are workspace content, never
    touched.
    """
    out: list[Path] = []
    seen: set[str] = set()

    def _add(p: Path) -> None:
        try:
            key = str(p.resolve())
        except OSError:
            key = str(p)
        if key in seen:
            return
        seen.add(key)
        out.append(p)

    # The task we were handed.
    if task.task_dir is not None:
        _add(task.task_dir)
    if task.task_meta_file is not None:
        _add(task.task_meta_file)

    # Re-scan every root so MSIX duplicates are caught even though discovery
    # merged them into a single Task.
    for root in _cowork_roots():
        if not root.exists():
            continue
        for acct in sorted(root.iterdir()):
            if not acct.is_dir():
                continue
            for workspace in sorted(acct.iterdir()):
                if not workspace.is_dir():
                    continue
                sandbox = workspace / f"local_{task.task_id}"
                meta = workspace / f"local_{task.task_id}.json"
                if sandbox.exists():
                    _add(sandbox)
                if meta.exists():
                    _add(meta)
    return out


def _confirm_purge_risk(plan: list[tuple[Task, list[Path]]], non_interactive_ack: bool) -> None:
    n = len(plan)
    lines = [
        "",
        "🔥  --purge-source requested. After a VERIFIED export, the local copy",
        f"    of {n} task(s) will be PERMANENTLY DELETED.",
        "",
        "    This removes each task's sandbox (transcript, uploads, outputs,",
        "    audit log) and its metadata. It does NOT touch the external",
        "    project folders the chat was attached to (userSelectedFolders),",
        "    nor spaces.json, nor any other task — only the selected task(s).",
        "",
        "    A task is deleted ONLY after its bundle is written and verified",
        "    (transcript.jsonl + manifest.json present and non-empty). You can",
        "    later restore it with `claude-cowork-export import <bundle>`.",
        "",
        "    To be deleted:",
    ]
    for task, paths in plan:
        lines.append(f"      • {task.task_id}  {task.display_title}")
        for p in paths:
            lines.append(f"          rm -r  {p}")
    lines.append("")
    print("\n".join(lines), file=sys.stderr)
    if non_interactive_ack:
        print("  ack: --yes-i-know-this-is-risky given; proceeding non-interactively.",
              file=sys.stderr)
        return
    try:
        ans = input('Type "DELETE" to confirm purge after export: ').strip()
    except EOFError:
        ans = ""
    if ans != "DELETE":
        print("  abort: confirmation phrase not received; nothing will be deleted.",
              file=sys.stderr)
        raise SystemExit(3)


def _purge_paths(paths: list[Path]) -> list[Path]:
    removed: list[Path] = []
    for p in paths:
        try:
            if p.is_dir() and not p.is_symlink():
                shutil.rmtree(p)
            elif p.exists() or p.is_symlink():
                p.unlink()
            else:
                continue
            removed.append(p)
        except OSError as e:
            print(f"  warn: failed to delete {p}: {e}", file=sys.stderr)
    return removed


def _copy_auth_for_export(target: Path, sources: list[Path]) -> dict[str, Any]:
    root = _cowork_userdata_root()
    auth_dir = target / "auth"
    auth_dir.mkdir(parents=True, exist_ok=True)
    files: list[str] = []
    for src in sources:
        try:
            rel = src.relative_to(root)
        except ValueError:
            rel = Path(src.name)
        dst = auth_dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_dir():
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            shutil.copy2(src, dst)
        files.append(str(Path("auth") / rel).replace("\\", "/"))
        try:
            os.chmod(dst, 0o600)
        except OSError:
            pass
    return {
        "included": True,
        "files": files,
        "source_userdata": str(root),
        "source_platform": sys.platform,
        "encrypted": True,
        "cross_platform_restorable": False,
    }


def _write_manifest(
    target: Path,
    task: Task,
    meta: SessionMeta,
    auth_info: dict[str, Any] | None,
) -> None:
    sandbox_prefix = ""
    if task.task_dir is not None:
        sandbox_prefix = str(task.task_dir.parent.parent.parent)
    manifest = {
        "bundle_version": BUNDLE_VERSION,
        "tool": "claude-cowork-export",
        "tool_version": TOOL_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "source_platform": sys.platform,
        "source_path_sep": os.sep,
        "source_home": str(HOME),
        "source_userdata": str(_cowork_userdata_root()),
        "source_sandbox_prefix": sandbox_prefix,
        "source_task_id": task.task_id,
        "source_cli_session_id": task.cli_session_id,
        "source_cwd": meta.cwd or "",
        "source_user_folders": list(meta.user_folders or []),
        "source_account_hint": "",
        "auth": auth_info or {"included": False},
    }
    (target / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def export_one(
    task: Task,
    output_root: Path,
    formats: Iterable[str],
    include_files: bool,
    auth_sources: list[Path] | None = None,
) -> Path | None:
    if not task.transcript_path or not task.transcript_path.exists():
        print(f"  warn: skipping {task.task_id} — no transcript file", file=sys.stderr)
        return None

    meta, raw = load_transcript(task.transcript_path)
    merge_task_meta(meta, task)
    flat = flatten(raw)
    touched = collect_touched_files(flat, meta.cwd) if include_files else []

    target = output_root / task.task_id
    target.mkdir(parents=True, exist_ok=True)

    shutil.copy2(task.transcript_path, target / "transcript.jsonl")
    if task.task_meta_file and task.task_meta_file.exists():
        shutil.copy2(task.task_meta_file, target / "task.json")
    audit_src = (task.task_dir / "audit.jsonl") if task.task_dir else None
    if audit_src and audit_src.exists():
        try:
            same_as_transcript = audit_src.resolve() == task.transcript_path.resolve()
        except OSError:
            same_as_transcript = False
        if not same_as_transcript:
            shutil.copy2(audit_src, target / "audit.jsonl")

    uploads_paths: list[Path] = []
    outputs_paths: list[Path] = []
    if include_files and task.task_dir:
        uploads_src = task.task_dir / "uploads"
        outputs_src = task.task_dir / "outputs"
        if uploads_src.exists():
            for f in list_dir_files(uploads_src):
                rel = f.relative_to(uploads_src)
                dest = target / "uploads" / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                try:
                    shutil.copy2(f, dest)
                    uploads_paths.append(dest)
                except OSError as e:
                    print(f"  warn: failed to copy {f}: {e}", file=sys.stderr)
        if outputs_src.exists():
            for f in list_dir_files(outputs_src):
                rel = f.relative_to(outputs_src)
                dest = target / "outputs" / rel
                dest.parent.mkdir(parents=True, exist_ok=True)
                try:
                    shutil.copy2(f, dest)
                    outputs_paths.append(dest)
                except OSError as e:
                    print(f"  warn: failed to copy {f}: {e}", file=sys.stderr)

    if include_files:
        cwd_p = Path(meta.cwd).resolve() if meta.cwd else None
        outputs_bundle = target / "outputs"
        for tf in touched:
            src = Path(tf.absolute_path)
            inside_cwd = False
            if cwd_p:
                try:
                    inside_cwd = _rel_to(src.resolve(), cwd_p) is not None
                except OSError:
                    inside_cwd = False
            if inside_cwd and outputs_bundle.exists():
                continue
            asset_rel = tf.relative_path or src.name
            target_path = target / "assets" / asset_rel
            target_path.parent.mkdir(parents=True, exist_ok=True)
            copied = False
            if tf.exists:
                try:
                    shutil.copy2(src, target_path)
                    copied = True
                except OSError:
                    copied = False
            if not copied and tf.recorded_content is not None:
                try:
                    target_path.write_text(tf.recorded_content, encoding="utf-8")
                    copied = True
                except OSError as e:
                    print(f"  warn: failed to write recorded content for {asset_rel}: {e}", file=sys.stderr)
            if not copied:
                if tf.edit_only:
                    print(
                        f"  note: {asset_rel} only had Edit/MultiEdit calls and is not readable; "
                        "skipping (no recorded full content available)",
                        file=sys.stderr,
                    )
                else:
                    print(f"  warn: could not snapshot {asset_rel}", file=sys.stderr)

    formats = list(formats)
    if "html" in formats:
        (target / "session.html").write_text(
            render_html(meta, flat, touched, uploads_paths, outputs_paths, target),
            encoding="utf-8",
        )
    if "md" in formats:
        (target / "session.md").write_text(
            render_markdown(meta, flat, touched, uploads_paths, outputs_paths, target),
            encoding="utf-8",
        )
    if "json" in formats:
        (target / "session.json").write_text(
            render_json(meta, flat, touched, uploads_paths, outputs_paths, target),
            encoding="utf-8",
        )
    if "csv" in formats:
        write_csv(target / "session.csv", flat)

    auth_info: dict[str, Any] | None = None
    if auth_sources:
        auth_info = _copy_auth_for_export(target, auth_sources)
    _write_manifest(target, task, meta, auth_info)

    _write_readme(target, task, meta, flat, touched, uploads_paths, outputs_paths, formats)
    return target


def _write_readme(
    target: Path,
    task: Task,
    meta: SessionMeta,
    flat: list[FlatMessage],
    touched: list[TouchedFile],
    uploads: list[Path],
    outputs: list[Path],
    formats: list[str],
) -> None:
    n_user = sum(1 for m in flat if m.kind == "text" and m.role == "user")
    n_asst = sum(1 for m in flat if m.kind == "text" and m.role == "assistant")
    n_tool = sum(1 for m in flat if m.kind == "tool_use")
    lines = [
        f"# {meta.title or task.task_id}",
        "",
        f"- Source: `{meta.source}`",
        f"- Task ID: `{meta.task_id}`",
        f"- CLI session: `{meta.cli_session_id}`",
    ]
    if meta.space_name:
        lines.append(f"- Space: {meta.space_name}")
    if meta.model:
        lines.append(f"- Model: {meta.model}")
    if meta.cwd:
        lines.append(f"- Working dir: `{meta.cwd}`")
    if meta.started_at:
        lines.append(f"- Started: {_fmt_ts(meta.started_at)}")
    if meta.ended_at:
        lines.append(f"- Ended: {_fmt_ts(meta.ended_at)}")
    lines.append(
        f"- Messages: {len(flat)} blocks ({n_user} user, {n_asst} assistant, {n_tool} tool calls)"
    )
    if uploads:
        lines.append(f"- Uploads: {len(uploads)}")
    if outputs:
        lines.append(f"- Outputs: {len(outputs)}")
    if touched:
        lines.append(f"- Files written/edited: {len(touched)}")
    lines += ["", "## Files in this bundle", ""]
    if "html" in formats:
        lines.append("- `session.html` — formatted reading view (open in a browser)")
    if "md" in formats:
        lines.append("- `session.md` — Markdown export")
    if "json" in formats:
        lines.append("- `session.json` — structured export for LLM consumption")
    if "csv" in formats:
        lines.append("- `session.csv` — flat per-block table")
    lines.append("- `transcript.jsonl` — raw JSONL transcript (lossless source)")
    if (target / "task.json").exists():
        lines.append("- `task.json` — original Cowork task metadata")
    if (target / "audit.jsonl").exists():
        lines.append("- `audit.jsonl` — Cowork audit log")
    if uploads:
        lines.append("- `uploads/` — files the user attached to this chat")
    if outputs:
        lines.append("- `outputs/` — files the assistant generated (Cowork output dir)")
    if touched:
        lines.append("- `assets/` — files written/edited outside the outputs dir")
    (target / "README.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def cmd_list(args: argparse.Namespace) -> int:
    override = Path(args.cowork_root).expanduser().resolve() if getattr(args, "cowork_root", None) else None
    tasks = discover(args.source, cowork_root_override=override)
    if getattr(args, "json", False):
        items = [
            {
                "task_id": t.task_id,
                "source": t.source,
                "title": t.title,
                "model": t.model,
                "space_name": t.space_name,
                "cwd": t.cwd,
                "created_at_ms": t.created_at_ms,
                "last_activity_ms": t.last_activity_ms,
                "archived": t.archived,
                "error": t.error,
                "has_transcript": t.transcript_path is not None,
                "transcript_path": str(t.transcript_path) if t.transcript_path else None,
                "task_dir": str(t.task_dir) if t.task_dir else None,
                "task_meta_file": str(t.task_meta_file) if t.task_meta_file else None,
            }
            for t in tasks
        ]
        print(json.dumps(items, ensure_ascii=False))
        return 0
    if not tasks:
        root = override or (COWORK_ROOT if args.source != "code" else CODE_ROOT)
        print(f"No sessions found under {root}")
        if args.source != "code" and not override and sys.platform == "win32":
            scanned = _cowork_roots()
            if scanned:
                print("Scanned Cowork roots:", file=sys.stderr)
                for r in scanned:
                    print(f"  {r}", file=sys.stderr)
        return 0
    for t in tasks:
        title = t.display_title
        if len(title) > 60:
            title = title[:57] + "…"
        archived = " [archived]" if t.archived else ""
        space = f" · {t.space_name}" if t.space_name else ""
        model = f" · {t.model}" if t.model else ""
        when = t.display_when
        ttype = t.source
        print(f"{t.task_id}  [{ttype}]  {when}  {title}{space}{model}{archived}")
        if t.cwd:
            print(f"   cwd: {t.cwd}")
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    formats = [f.strip().lower() for f in args.formats.split(",") if f.strip()]
    invalid = [f for f in formats if f not in SUPPORTED_FORMATS]
    if invalid:
        print(f"error: unknown format(s): {', '.join(invalid)}", file=sys.stderr)
        return 2

    override = Path(args.cowork_root).expanduser().resolve() if getattr(args, "cowork_root", None) else None
    tasks = discover(args.source, cowork_root_override=override)
    if not tasks:
        root = override or (COWORK_ROOT if args.source != "code" else CODE_ROOT)
        print(f"No sessions found under {root}", file=sys.stderr)
        return 1

    targets = resolve_tasks(args.session, tasks)
    if not targets:
        print(f"No session matched '{args.session}'", file=sys.stderr)
        return 1
    if len(targets) > 1 and args.session != "all":
        print(f"Ambiguous selector '{args.session}' matched {len(targets)} tasks:", file=sys.stderr)
        for t in targets:
            print(f"  {t.task_id}  {t.display_title}", file=sys.stderr)
        return 1

    output_root = Path(args.output).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    purge_source = bool(getattr(args, "purge_source", False))
    ack = bool(getattr(args, "yes_i_know_this_is_risky", False))
    if purge_source and args.no_files:
        print(
            "error: --purge-source cannot be combined with --no-files.\n"
            "       Purging would delete the task sandbox (uploads / outputs)\n"
            "       while the bundle omits them, so they could not be restored.",
            file=sys.stderr,
        )
        return 2

    auth_sources: list[Path] | None = None
    if getattr(args, "include_auth", False):
        auth_sources = _resolve_auth_sources()
        if not auth_sources:
            print(
                "error: --include-auth requested but no Cowork auth artefacts were\n"
                f"       found under {_cowork_userdata_root()}.\n"
                "       Skip --include-auth and sign in on the destination instead.",
                file=sys.stderr,
            )
            return 2
        _confirm_auth_risk(ack)

    if purge_source:
        plan = [(t, _cowork_task_purge_targets(t)) for t in targets]
        _confirm_purge_risk(plan, ack)

    progress_json = bool(getattr(args, "progress_json", False))

    def _emit(event: dict[str, Any]) -> None:
        print(json.dumps(event, ensure_ascii=False), flush=True)

    exported = 0
    purged = 0
    total = len(targets)
    for index, task in enumerate(targets, 1):
        if progress_json:
            _emit({"event": "task_start", "task_id": task.task_id, "index": index, "total": total})
        target = export_one(
            task,
            output_root,
            formats,
            include_files=not args.no_files,
            auth_sources=auth_sources,
        )
        if target:
            if progress_json:
                _emit({"event": "task_done", "task_id": task.task_id, "target": str(target)})
            else:
                print(f"exported {task.task_id} → {target}")
            exported += 1
            if purge_source:
                if _bundle_is_complete(target):
                    removed = _purge_paths(_cowork_task_purge_targets(task))
                    for p in removed:
                        if progress_json:
                            _emit({"event": "purged", "task_id": task.task_id, "path": str(p)})
                        else:
                            print(f"  purged {p}")
                    purged += 1
                else:
                    print(
                        f"  warn: bundle for {task.task_id} failed verification; "
                        "source NOT purged.",
                        file=sys.stderr,
                    )
        elif progress_json:
            _emit({"event": "task_skipped", "task_id": task.task_id, "reason": "no transcript file"})
    if progress_json:
        _emit({"event": "done", "exported": exported, "total": total})
    if not exported:
        return 1
    if purge_source and not progress_json:
        print(f"purged {purged}/{exported} exported task(s) from local store.")
    return 0


WINDOWS_RESERVED_CHARS = set('<>:"|?*')


def _validate_path_for_windows(path: str) -> str | None:
    if not path:
        return None
    tail = path
    if len(path) >= 2 and path[1] == ":" and path[0].isalpha():
        tail = path[2:]
    bad = sorted({c for c in tail if c in WINDOWS_RESERVED_CHARS})
    if bad:
        return f"contains chars not allowed on Windows: {''.join(bad)!r}"
    return None


def _starts_with_path(path: str, prefix: str, platform: str) -> bool:
    if not path or not prefix:
        return False
    if len(path) < len(prefix):
        return False
    p, c = (path.lower(), prefix.lower()) if platform == "win32" else (path, prefix)
    if not p.startswith(c):
        return False
    if len(path) == len(prefix):
        return True
    return path[len(prefix)] in ("/", "\\")


def _rewrite_path_prefix(
    path: str,
    src_prefix: str,
    dst_prefix: str,
    src_sep: str,
    dst_sep: str,
    src_platform: str,
) -> str:
    if not path or not _starts_with_path(path, src_prefix, src_platform):
        return path
    tail = path[len(src_prefix):]
    if src_sep != dst_sep:
        tail = tail.replace(src_sep, dst_sep)
    return dst_prefix + tail


def _apply_remaps(
    path: str,
    remaps: list[tuple[str, str]],
    src_sep: str,
    dst_sep: str,
    src_platform: str,
) -> str:
    for src, dst in remaps:
        rewritten = _rewrite_path_prefix(path, src, dst, src_sep, dst_sep, src_platform)
        if rewritten != path:
            return rewritten
    return path


def _rewrite_jsonl(
    src_jsonl: Path,
    dst_jsonl: Path,
    cwd_remap: tuple[str, str],
    extra_remaps: list[tuple[str, str]],
    src_sep: str,
    dst_sep: str,
    src_platform: str,
) -> dict[str, int]:
    counts = {"cwd": 0, "file_path": 0, "notebook_path": 0, "records": 0}
    src_cwd, dst_cwd = cwd_remap
    all_remaps = [(src_cwd, dst_cwd)] + extra_remaps
    dst_jsonl.parent.mkdir(parents=True, exist_ok=True)
    with src_jsonl.open("r", encoding="utf-8") as fin, \
            dst_jsonl.open("w", encoding="utf-8") as fout:
        for line in fin:
            stripped = line.rstrip("\n")
            if not stripped.strip():
                fout.write(line); continue
            try:
                obj = json.loads(stripped)
            except json.JSONDecodeError:
                fout.write(line); continue
            counts["records"] += 1
            if isinstance(obj.get("cwd"), str):
                new = _apply_remaps(obj["cwd"], all_remaps, src_sep, dst_sep, src_platform)
                if new != obj["cwd"]:
                    counts["cwd"] += 1
                    obj["cwd"] = new
            msg = obj.get("message")
            if isinstance(msg, dict):
                content = msg.get("content")
                if isinstance(content, list):
                    for block in content:
                        if not isinstance(block, dict) or block.get("type") != "tool_use":
                            continue
                        inp = block.get("input")
                        if not isinstance(inp, dict):
                            continue
                        for key in ("file_path", "notebook_path"):
                            v = inp.get(key)
                            if isinstance(v, str):
                                new = _apply_remaps(v, all_remaps, src_sep, dst_sep, src_platform)
                                if new != v:
                                    counts[key] += 1
                                    inp[key] = new
            fout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    return counts


def _rewrite_task_json(
    src_task_json: Path,
    dst_task_json: Path,
    cwd_remap: tuple[str, str],
    sandbox_remap: tuple[str, str],
    new_task_id: str,
    new_cli_session_id: str,
    extra_remaps: list[tuple[str, str]],
    src_sep: str,
    dst_sep: str,
    src_platform: str,
) -> dict[str, Any]:
    data = json.loads(src_task_json.read_text(encoding="utf-8"))
    all_remaps = [cwd_remap, sandbox_remap] + extra_remaps
    if isinstance(data.get("cwd"), str):
        data["cwd"] = _apply_remaps(data["cwd"], all_remaps, src_sep, dst_sep, src_platform)
    if isinstance(data.get("userSelectedFolders"), list):
        data["userSelectedFolders"] = [
            _apply_remaps(p, extra_remaps, src_sep, dst_sep, src_platform) if isinstance(p, str) else p
            for p in data["userSelectedFolders"]
        ]
    if isinstance(data.get("userApprovedFileAccessPaths"), list):
        data["userApprovedFileAccessPaths"] = [
            _apply_remaps(p, extra_remaps, src_sep, dst_sep, src_platform) if isinstance(p, str) else p
            for p in data["userApprovedFileAccessPaths"]
        ]
    data["sessionId"] = f"local_{new_task_id}"
    if new_cli_session_id:
        data["cliSessionId"] = new_cli_session_id
    data["processName"] = f"imported-{new_task_id[:8]}"
    data["vmProcessName"] = data["processName"]
    dst_task_json.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return data


def _workspace_leaves(root: Path) -> list[Path]:
    """Every root/<account>/<workspace> directory under a Cowork root."""
    leaves: list[Path] = []
    for acct in sorted(p for p in root.iterdir() if p.is_dir() and p.name != "skills-plugin"):
        leaves.extend(sorted(p for p in acct.iterdir() if p.is_dir() and p.name != "skills-plugin"))
    return leaves


def _pick_target_workspace(roots: list[Path], workspace_arg: str | None) -> tuple[Path, Path, Path]:
    """Return (root, acct, workspace) on the target machine. Errors out if
    detection is ambiguous and the user did not specify --workspace."""
    if not roots:
        raise SystemExit("error: no Cowork install detected on this machine.")
    if workspace_arg:
        target = Path(workspace_arg).expanduser().resolve()
        if not target.is_dir():
            raise SystemExit(f"error: --workspace {target} does not exist")
        for r in roots:
            try:
                rel = target.relative_to(r)
            except ValueError:
                continue
            if len(rel.parts) != 2:
                leaves = _workspace_leaves(r)
                hint = ("; workspaces under it:\n  " + "\n  ".join(str(w) for w in leaves)) if leaves else ""
                raise SystemExit(
                    f"error: --workspace {target} is not a workspace dir; it must "
                    f"be an <account>/<workspace> path two levels below the "
                    f"Cowork root {r}{hint}"
                )
            return r, target.parent, target
        raise SystemExit(f"error: --workspace {target} is not inside any detected Cowork root")
    root = roots[0]
    accts = sorted([
        p for p in root.iterdir()
        if p.is_dir() and p.name != "skills-plugin"
    ])
    if not accts:
        raise SystemExit(f"error: no account directories found under {root}")
    if len(accts) > 1:
        leaves = _workspace_leaves(root)
        raise SystemExit(
            "error: multiple Cowork accounts detected; pick one with --workspace:\n  "
            + "\n  ".join(str(c) for c in (leaves or accts))
        )
    workspaces = sorted([p for p in accts[0].iterdir() if p.is_dir() and p.name != "skills-plugin"])
    if not workspaces:
        raise SystemExit(f"error: no workspaces found under {accts[0]}")
    if len(workspaces) > 1:
        raise SystemExit(
            "error: multiple workspaces detected; pick one with --workspace:\n  "
            + "\n  ".join(str(w) for w in workspaces)
        )
    return root, accts[0], workspaces[0]


def cmd_import(args: argparse.Namespace) -> int:
    import uuid as _uuid
    bundle = Path(args.bundle).expanduser().resolve()
    if not bundle.is_dir():
        print(f"error: bundle directory does not exist: {bundle}", file=sys.stderr)
        return 2
    manifest_path = bundle / "manifest.json"
    if not manifest_path.exists():
        print(
            f"error: not a valid bundle (missing manifest.json): {bundle}\n"
            f"       Bundles produced before tool 0.2.0 lack a manifest. Re-export.",
            file=sys.stderr,
        )
        return 2
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"error: failed to parse manifest.json: {e}", file=sys.stderr)
        return 2
    if manifest.get("tool") != "claude-cowork-export":
        print(
            f"error: bundle was produced by {manifest.get('tool')!r}, expected "
            "'claude-cowork-export'.",
            file=sys.stderr,
        )
        return 2

    src_platform = manifest.get("source_platform") or ""
    src_sep = manifest.get("source_path_sep") or ("\\" if src_platform == "win32" else "/")
    src_cwd = manifest.get("source_cwd") or ""
    src_sandbox = manifest.get("source_sandbox_prefix") or ""
    src_task_id = manifest.get("source_task_id") or ""
    src_user_folders = manifest.get("source_user_folders") or []
    bundle_auth = bundle / "auth"

    dst_platform = sys.platform
    dst_sep = "\\" if dst_platform == "win32" else "/"

    # Cross-platform auth refusal
    has_auth = bundle_auth.is_dir() and any(bundle_auth.iterdir())
    install_auth = has_auth and not args.skip_auth
    if install_auth and src_platform != dst_platform:
        print(
            f"error: bundle was exported on {src_platform}; importing on {dst_platform} cannot\n"
            "       reuse Cowork desktop auth (macOS Keychain ↔ Windows DPAPI keys are not\n"
            "       interoperable). Re-run with --skip-auth and sign in on the destination.",
            file=sys.stderr,
        )
        return 2

    # Parse --remap flags
    remaps: list[tuple[str, str]] = []
    for r in (args.remap or []):
        if "=" not in r:
            print(f"error: --remap expects src=dst, got {r!r}", file=sys.stderr)
            return 2
        s, d = r.split("=", 1)
        remaps.append((s, d))

    # Require remaps for every userSelectedFolder
    for f in src_user_folders:
        if not any(_starts_with_path(f, s, src_platform) for s, _ in remaps):
            print(
                f"error: source userSelectedFolders entry has no --remap mapping:\n"
                f"       {f}\n"
                f"       Re-run with --remap {f!r}=<target-path>",
                file=sys.stderr,
            )
            return 2

    # Discover target Cowork workspace
    if getattr(args, "cowork_root", None):
        cowork_roots = [Path(args.cowork_root).expanduser().resolve()]
    else:
        cowork_roots = _cowork_roots()
    try:
        target_root, target_acct, target_workspace = _pick_target_workspace(
            cowork_roots, getattr(args, "workspace", None)
        )
    except SystemExit as exc:
        print(exc.args[0] if exc.args else "error", file=sys.stderr)
        return 2

    # Generate new task id / cli session id
    new_task_id = src_task_id if args.keep_task_id else str(_uuid.uuid4())
    new_cli_session_id = str(_uuid.uuid4())
    new_task_dir = target_workspace / f"local_{new_task_id}"
    new_task_meta = target_workspace / f"local_{new_task_id}.json"
    new_cwd = str(new_task_dir / "outputs")

    if dst_platform == "win32":
        msg = _validate_path_for_windows(new_cwd)
        if msg:
            print(f"error: target cwd {new_cwd!r} {msg}", file=sys.stderr)
            return 2

    dst_sandbox = str(target_root)
    cwd_remap = (src_cwd, new_cwd)
    sandbox_remap = (src_sandbox, dst_sandbox)

    # Plan output
    print(f"Source bundle: {bundle}")
    print(f"  tool_version:       {manifest.get('tool_version')}")
    print(f"  exported_at:        {manifest.get('exported_at')}")
    print(f"  source_platform:    {src_platform}")
    print(f"  source_task_id:     {src_task_id}")
    print(f"  source_cwd:         {src_cwd}")
    print(f"  source_user_folders: {src_user_folders}")
    print()
    print(f"Target ({dst_platform}):")
    print(f"  workspace:          {target_workspace}")
    print(f"  new_task_id:        {new_task_id}")
    print(f"  new_cli_session_id: {new_cli_session_id}")
    print(f"  new_task_dir:       {new_task_dir}")
    print(f"  new_task_meta:      {new_task_meta}")
    print(f"  new_cwd:            {new_cwd}")
    if remaps:
        print(f"  user folder remaps: {len(remaps)}")
        for s, d in remaps:
            print(f"    {s} → {d}")
    if has_auth:
        if install_auth:
            print(f"  auth: {sum(1 for _ in bundle_auth.iterdir())} artefact(s) → "
                  f"{_cowork_userdata_root()}/ (same-platform restore)")
        else:
            print(f"  auth: skipped ({'--skip-auth' if args.skip_auth else 'cross-platform refusal'})")

    if args.dry_run:
        print()
        print("Dry-run: no files written.")
        return 0

    if new_task_dir.exists() and not args.force:
        print(f"error: {new_task_dir} already exists. Use --force to overwrite.",
              file=sys.stderr)
        return 3

    new_task_dir.mkdir(parents=True, exist_ok=True)
    (new_task_dir / "outputs").mkdir(exist_ok=True)
    (new_task_dir / "uploads").mkdir(exist_ok=True)

    print()
    # Rewrite task.json
    if manifest.get("source_task_id"):
        src_task_meta = bundle / "task.json"
        if src_task_meta.exists():
            _rewrite_task_json(
                src_task_meta, new_task_meta, cwd_remap, sandbox_remap,
                new_task_id, new_cli_session_id, remaps, src_sep, dst_sep, src_platform,
            )
            print(f"wrote {new_task_meta}")

    # Rewrite transcript.jsonl into the task's .claude/projects/<encoded>/
    src_transcript = bundle / "transcript.jsonl"
    if src_transcript.exists():
        encoded = new_cwd.replace("\\", "-").replace("/", "-").replace(":", "-").replace("_", "-")
        target_transcript = new_task_dir / ".claude" / "projects" / encoded / f"{new_cli_session_id}.jsonl"
        counts = _rewrite_jsonl(
            src_transcript, target_transcript, cwd_remap, remaps,
            src_sep, dst_sep, src_platform,
        )
        print(
            f"wrote {target_transcript}  "
            f"(records: {counts['records']}, cwd: {counts['cwd']}, "
            f"file_path: {counts['file_path']}, notebook_path: {counts['notebook_path']})"
        )

    # Rewrite audit.jsonl at task root
    src_audit = bundle / "audit.jsonl"
    if src_audit.exists():
        counts = _rewrite_jsonl(
            src_audit, new_task_dir / "audit.jsonl", cwd_remap, remaps,
            src_sep, dst_sep, src_platform,
        )
        print(
            f"wrote {new_task_dir / 'audit.jsonl'}  "
            f"(records: {counts['records']}, cwd: {counts['cwd']})"
        )

    # Copy uploads / outputs verbatim
    for sub in ("uploads", "outputs"):
        srcdir = bundle / sub
        if srcdir.is_dir():
            for p in srcdir.rglob("*"):
                if p.is_file():
                    rel = p.relative_to(srcdir)
                    dst = new_task_dir / sub / rel
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(p, dst)

    # Install auth (same-platform only — cross-platform was vetoed earlier)
    if install_auth:
        ud = _cowork_userdata_root()
        ud.mkdir(parents=True, exist_ok=True)
        installed = 0
        for p in bundle_auth.iterdir():
            dst = ud / p.name
            if dst.exists() and not args.force:
                print(f"  skip (exists): {dst}")
                continue
            if p.is_dir():
                shutil.copytree(p, dst, dirs_exist_ok=True)
            else:
                shutil.copy2(p, dst)
            installed += 1
        print(f"installed {installed} auth artefact(s) under {ud}")

    print()
    print(f"Done. Restart Cowork desktop; the imported task should appear in the sidebar")
    print(f"with the new task id ({new_task_id}).")
    return 0


def _truncate(text: str, limit: int) -> str:
    text = text or ""
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + f"\n… [truncated, {len(text) - limit} more chars]"


def _demote_headers(text: str, by: int = 2) -> str:
    """Prepend ``by`` more ``#`` chars to ATX heading lines so embedded
    headings don't compete with the seed's own structure. Code-fenced
    regions are left alone."""
    if not text:
        return text
    out, in_fence = [], False
    for line in text.split("\n"):
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            out.append(line); continue
        if in_fence:
            out.append(line); continue
        if line.startswith("#"):
            i = 0
            while i < len(line) and line[i] == "#":
                i += 1
            if 1 <= i <= 6 and (i == len(line) or line[i] in (" ", "\t")):
                out.append("#" * min(6, i + by) + line[i:])
                continue
        out.append(line)
    return "\n".join(out)


def _summarise_tool_use(m: FlatMessage) -> str:
    tn = m.tool_name or "?"
    inp = m.tool_input if isinstance(m.tool_input, dict) else {}
    bits = []
    for key in ("command", "file_path", "notebook_path", "pattern", "path", "url", "query"):
        v = inp.get(key)
        if isinstance(v, str) and v:
            bits.append(f"{key}={_truncate(v, SEED_TOOL_INPUT_TRUNCATE)!r}")
            break
    return f"`{tn}`" + (f" ({', '.join(bits)})" if bits else "")


def _summarise_tool_result(m: FlatMessage) -> str:
    txt = (m.text or "").strip()
    if not txt:
        return "(empty)"
    return _truncate(txt, SEED_TOOL_RESULT_TRUNCATE)


def _list_bundle_files_cowork(bundle: Path) -> list[tuple[str, Path, int]]:
    out: list[tuple[str, Path, int]] = []
    for cat, sub in (("upload", "uploads"), ("output", "outputs"), ("asset", "assets")):
        d = bundle / sub
        if d.is_dir():
            for p in sorted(d.rglob("*")):
                if p.is_file():
                    try:
                        out.append((cat, p.relative_to(bundle), p.stat().st_size))
                    except OSError:
                        pass
    return out


def _render_turn_for_seed(out: list[str], turn: dict[str, Any], mode: str, index: int) -> None:
    user_msg: FlatMessage = turn["user"]
    body: list[FlatMessage] = turn["body"]
    user_text = _strip_uploaded_files_wrapper(user_msg.text or "").strip()
    out.append(f"### Turn {index} · {_fmt_ts(user_msg.timestamp)}")
    out.append("")
    out.append("**User:**")
    out.append("")
    out.append("> " + user_text.replace("\n", "\n> ") if user_text else "> _(empty)_")
    out.append("")

    asst_text_blocks = [m for m in body if m.kind == "text" and m.role == "assistant"]
    tool_uses = [m for m in body if m.kind == "tool_use"]
    tool_results = {m.tool_id: m for m in body if m.kind == "tool_result"}

    if mode == "full":
        for m in body:
            if m.kind == "text" and m.role == "assistant":
                out.append("**Assistant:**")
                out.append("")
                out.append(_demote_headers(m.text) or "_(empty)_")
                out.append("")
            elif m.kind == "thinking":
                out.append("<details><summary>Reasoning</summary>")
                out.append("")
                out.append(m.text or "")
                out.append("")
                out.append("</details>")
                out.append("")
            elif m.kind == "tool_use":
                out.append(f"_Tool call:_ {_summarise_tool_use(m)}")
                tr = tool_results.get(m.tool_id)
                if tr:
                    out.append("_Tool error:_" if tr.is_error else "_Tool result:_")
                    out.append("")
                    out.append("```")
                    out.append(_summarise_tool_result(tr))
                    out.append("```")
                out.append("")
    elif mode == "standard":
        if asst_text_blocks:
            joined = "\n\n".join(b.text or "" for b in asst_text_blocks).strip()
            out.append("**Assistant** (abridged):")
            out.append("")
            out.append(_demote_headers(_truncate(joined, SEED_TEXT_TRUNCATE)) or "_(no textual reply)_")
            out.append("")
        if tool_uses:
            out.append(f"_Tool calls in this turn: {len(tool_uses)}_")
            for m in tool_uses[:6]:
                tr = tool_results.get(m.tool_id)
                marker = " ❌" if tr and tr.is_error else ""
                out.append(f"- {_summarise_tool_use(m)}{marker}")
            if len(tool_uses) > 6:
                out.append(f"- … +{len(tool_uses) - 6} more")
            out.append("")


def render_seed_prompt(
    meta: SessionMeta,
    flat: list[FlatMessage],
    bundle_files: list[tuple[str, Path, int]],
    mode: str,
    bundle: Path,
) -> str:
    if mode not in ("brief", "standard", "full"):
        raise ValueError(f"unknown seed mode: {mode}")
    preamble, turns = _split_into_turns(flat)
    n_user = len(turns)
    n_tool = sum(1 for m in flat if m.kind == "tool_use")
    n_think = sum(1 for m in flat if m.kind == "thinking")
    title = meta.title or f"Claude Cowork task {meta.task_id[:8]}"

    out: list[str] = []
    out.append(f"# Continuation of a previous Cowork chat")
    out.append("")
    out.append(
        "I'm resuming a previous Claude Cowork chat in a fresh conversation "
        "(possibly under a different account or on a different machine). "
        "Below is the context from the prior task — what we were working on, "
        "the files involved, and where we left off. Please read it through, "
        "then confirm you've absorbed the context and are ready to continue."
    )
    out.append("")
    out.append("---")
    out.append("")
    out.append("## Previous task metadata")
    out.append("")
    out.append(f"- **Title**: {title}")
    if meta.model:
        out.append(f"- **Model**: `{meta.model}`")
    if meta.space_name:
        out.append(f"- **Space**: {meta.space_name}")
    if meta.cwd:
        out.append(f"- **Working dir** (on the original sandbox): `{meta.cwd}`")
    if meta.user_folders:
        out.append(f"- **User-selected folders** (on the original machine):")
        for f in meta.user_folders:
            out.append(f"  - `{f}`")
    if meta.started_at:
        out.append(f"- **Started**: {_fmt_ts(meta.started_at)}")
    if meta.ended_at:
        out.append(f"- **Ended**: {_fmt_ts(meta.ended_at)}")
    if meta.archived:
        out.append(f"- **Archived**: yes")
    if meta.error:
        out.append(f"- **Last-seen error**: {meta.error}")
    out.append(
        f"- **Activity**: {n_user} user prompt(s), {n_think} reasoning blocks, "
        f"{n_tool} tool call(s)"
    )
    out.append("")

    if meta.initial_message:
        out.append("## Initial brief")
        out.append("")
        out.append(
            "_The original task was opened with this brief. Treat it as the "
            "long-standing goal that any continuation should still serve._"
        )
        out.append("")
        out.append(
            "> " + _demote_headers(meta.initial_message.strip()).replace("\n", "\n> ")
        )
        out.append("")

    if bundle_files:
        out.append("## Files carried over from the previous session")
        out.append("")
        out.append(
            "The export bundle contains these files. They are either restored "
            "into the new task working directory by the importer or sit next "
            "to this seed prompt as raw bytes."
        )
        out.append("")
        for cat, rel, size in bundle_files:
            out.append(f"- `{rel}` ({_human_size(size)}) — {cat}")
        out.append("")

    if mode == "brief":
        keep_turns = turns[-3:] if len(turns) > 3 else turns
        out.append(f"## Last {len(keep_turns)} exchange(s) (verbatim)")
        out.append("")
        for i, turn in enumerate(keep_turns, 1):
            _render_turn_for_seed(out, turn, mode="full", index=n_user - len(keep_turns) + i)
    else:
        out.append("## Conversation summary")
        out.append("")
        if mode == "standard":
            out.append(
                "_Earlier turns are summarised; the final exchange is verbatim. "
                "Pass `--mode full` to `seed` if you need everything verbatim._"
            )
            out.append("")
        for i, turn in enumerate(turns[:-1] if turns else [], 1):
            _render_turn_for_seed(out, turn, mode=mode, index=i)
        if turns:
            out.append("### Final exchange (verbatim)")
            out.append("")
            _render_turn_for_seed(out, turns[-1], mode="full", index=n_user)

    out.append("---")
    out.append("")
    out.append("## Please continue from here")
    out.append("")
    out.append(
        "1. Confirm you've internalised the context above — note the files "
        "in scope, the working directory, and where the conversation left off."
    )
    out.append(
        "2. If you would have done something next in the previous session, "
        "surface it now so I can approve or correct it."
    )
    out.append(
        "3. Otherwise wait for my next instruction; I'll tell you what to "
        "tackle next."
    )
    out.append("")
    out.append("**Important**: any absolute paths in the context above refer to the")
    out.append("**original sandbox / machine**. If a path doesn't exist here, ask")
    out.append("me how to relocate it before reading or writing it.")
    out.append("")
    return "\n".join(out)


def cmd_seed(args: argparse.Namespace) -> int:
    bundle = Path(args.bundle).expanduser().resolve()
    if not bundle.is_dir():
        print(f"error: bundle directory does not exist: {bundle}", file=sys.stderr)
        return 2
    manifest_path = bundle / "manifest.json"
    if not manifest_path.exists():
        print(
            f"error: not a valid bundle (missing manifest.json): {bundle}\n"
            "       Re-export with claude-cowork-export >= 0.2.0.",
            file=sys.stderr,
        )
        return 2
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"error: failed to parse manifest.json: {e}", file=sys.stderr)
        return 2
    if manifest.get("tool") != "claude-cowork-export":
        print(
            f"error: bundle was produced by {manifest.get('tool')!r}, expected "
            "'claude-cowork-export'.",
            file=sys.stderr,
        )
        return 2

    transcript = bundle / "transcript.jsonl"
    if not transcript.exists():
        print(f"error: bundle missing transcript.jsonl: {transcript}", file=sys.stderr)
        return 2

    meta, raw = load_transcript(transcript)

    # Enrich meta from task.json (Cowork puts richer metadata there).
    task_meta = bundle / "task.json"
    if task_meta.exists():
        try:
            tj = json.loads(task_meta.read_text(encoding="utf-8"))
            meta.title = meta.title or tj.get("title", "") or ""
            meta.model = meta.model or tj.get("model", "") or ""
            meta.initial_message = meta.initial_message or tj.get("initialMessage", "") or ""
            meta.user_folders = meta.user_folders or list(tj.get("userSelectedFolders") or [])
            meta.archived = meta.archived or bool(tj.get("isArchived"))
            meta.error = meta.error or tj.get("error", "") or ""
            if not meta.cwd:
                meta.cwd = tj.get("cwd", "") or meta.cwd
        except Exception:
            pass
    meta.task_id = meta.task_id or manifest.get("source_task_id") or meta.cli_session_id

    flat = flatten(raw)
    files = _list_bundle_files_cowork(bundle)
    mode = args.mode
    seed_md = render_seed_prompt(meta, flat, files, mode, bundle)

    out_path = (
        Path(args.output).expanduser().resolve()
        if args.output else (bundle / "seed-prompt.md")
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(seed_md, encoding="utf-8")
    print(f"wrote {out_path}  ({len(seed_md)} chars, mode={mode})")
    print()
    print("Use:")
    print("  1. Open a fresh Cowork chat under the new account / machine.")
    print(f"  2. Paste the contents of {out_path} as your first message.")
    print("  3. Wait for the assistant to confirm context absorption.")
    print("  4. Continue working as usual.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="cowork_export",
        description="Export Claude Cowork (and Code) sessions to HTML, Markdown, JSON, CSV.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            examples:
              cowork_export.py list
              cowork_export.py list --source code
              cowork_export.py export latest
              cowork_export.py export <task-id> --output ./exports
              cowork_export.py export all --formats html,json
              cowork_export.py export latest --source code
        """),
    )
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--source",
        default="cowork",
        choices=("cowork", "code", "both"),
        help="which session store to read (default: cowork)",
    )
    common.add_argument(
        "--cowork-root",
        default=None,
        metavar="PATH",
        help=(
            "override the auto-detected Cowork sessions directory "
            "(e.g. %%LOCALAPPDATA%%\\Packages\\Claude_*\\LocalCache\\Roaming\\Claude\\local-agent-mode-sessions "
            "on Windows MSIX installs). Useful when auto-detection misses tasks."
        ),
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser(
        "list", parents=[common], help="list available sessions"
    )
    pl.add_argument(
        "--json", action="store_true",
        help="emit a machine-readable JSON array on stdout instead of human output "
             "(empty array when no sessions found)",
    )
    pl.set_defaults(func=cmd_list)

    pe = sub.add_parser("export", parents=[common], help="export one or more sessions")
    pe.add_argument("session", help="task id (prefix), 'latest', or 'all'")
    pe.add_argument(
        "-o", "--output", "--out",
        dest="output",
        default=str(DEFAULT_OUTPUT),
        metavar="DIR",
        help=f"directory to write export bundles into (default: {DEFAULT_OUTPUT})",
    )
    pe.add_argument(
        "--formats",
        default=",".join(SUPPORTED_FORMATS),
        help=f"comma-separated subset of {','.join(SUPPORTED_FORMATS)} (default: all)",
    )
    pe.add_argument("--no-files", action="store_true", help="skip copying uploads / outputs / touched files")
    pe.add_argument(
        "--include-auth", action="store_true",
        help=(
            "HIGH RISK: also include Cowork desktop's auth artefacts (Cookies, "
            "Local State, etc.) so a matching same-platform import can resume "
            "without re-logging in. Anyone with the bundle can act as your "
            "account. Cross-platform import will REFUSE to install these. "
            "Interactive 'I UNDERSTAND' prompt by default."
        ),
    )
    pe.add_argument(
        "--purge-source", action="store_true",
        help=(
            "DESTRUCTIVE: after each task's bundle is written AND verified, "
            "delete that task's local sandbox (transcript, uploads, outputs, "
            "audit log) and metadata. The external project folders the chat "
            "was attached to (userSelectedFolders) are never touched, nor are "
            "other tasks. Cannot be combined with --no-files. Interactive "
            "'DELETE' prompt by default."
        ),
    )
    pe.add_argument(
        "--yes-i-know-this-is-risky", action="store_true",
        help=(
            "skip the interactive confirmation prompts for --include-auth "
            "and --purge-source. For non-interactive / CI use only."
        ),
    )
    pe.add_argument(
        "--progress-json", action="store_true",
        help=(
            "emit flushed NDJSON progress events on stdout (one JSON object "
            "per line) instead of human progress lines. Warnings still go "
            "to stderr."
        ),
    )
    pe.set_defaults(func=cmd_export)

    pi = sub.add_parser(
        "import",
        help="restore a previously exported Cowork bundle as a new task",
        description=(
            "Restore a bundle into Cowork's local-agent-mode-sessions tree. "
            "A fresh task_id is generated by default (use --keep-task-id to "
            "preserve the original). Path-bearing fields in task.json / "
            "transcript.jsonl / audit.jsonl are rewritten to point at the new "
            "task dir; sources for userSelectedFolders that don't exist on "
            "this machine must be relocated with --remap src=dst."
        ),
    )
    pi.add_argument("bundle", help="path to an exported bundle directory")
    pi.add_argument(
        "--cowork-root", default=None, metavar="PATH",
        help=(
            "override the auto-detected Cowork sessions root on the target "
            "machine. Useful for testing or for archived restores. Same shape "
            "as the export-side flag."
        ),
    )
    pi.add_argument(
        "--workspace", default=None, metavar="PATH",
        help=(
            "destination workspace dir (.../<acct>/<workspace>/). "
            "Required when multiple Cowork accounts/workspaces are detected."
        ),
    )
    pi.add_argument(
        "--remap", action="append", metavar="SRC=DST",
        help=(
            "remap a userSelectedFolder / file_path prefix from source to "
            "target. Repeat for each folder. Required for every "
            "userSelectedFolders entry in the manifest."
        ),
    )
    pi.add_argument(
        "--keep-task-id", action="store_true",
        help="reuse the source task_id instead of generating a fresh one (may "
             "collide with an existing task; combine with --force to overwrite).",
    )
    pi.add_argument(
        "--skip-auth", action="store_true",
        help="ignore bundle/auth/ even if present.",
    )
    pi.add_argument(
        "--dry-run", action="store_true",
        help="print the rewrite plan and exit without writing.",
    )
    pi.add_argument(
        "--force", action="store_true",
        help="overwrite existing task dir / auth artefacts.",
    )
    pi.set_defaults(func=cmd_import)

    ps = sub.add_parser(
        "seed",
        help="render seed-prompt.md from a bundle for cross-account continuation",
        description=(
            "Produce a self-contained Markdown prompt that can be pasted as "
            "the first message of a brand-new Cowork chat (potentially under "
            "a different account / machine) to continue the work from where "
            "the previous task left off. Does not touch any auth, does not "
            "rely on server-side state — the new chat is a fresh task with "
            "the prior context inlined."
        ),
    )
    ps.add_argument("bundle", help="path to an exported bundle directory")
    ps.add_argument(
        "--mode", default="standard", choices=("brief", "standard", "full"),
        help=(
            "how much of the prior conversation to include. brief = last 3 turns; "
            "standard (default) = all user prompts + abridged assistant text + "
            "tool-call summaries + last turn verbatim; full = everything verbatim."
        ),
    )
    ps.add_argument(
        "-o", "--output", "--out", dest="output", default=None, metavar="PATH",
        help="where to write the seed prompt (default: <bundle>/seed-prompt.md)",
    )
    ps.set_defaults(func=cmd_seed)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except BrokenPipeError:
        # The reader on the other end of our pipe went away (e.g. `head`, or
        # a closing GUI host). Exit hard so the interpreter's shutdown flush
        # can't raise a second time.
        os._exit(1)
    except OSError as e:
        # Windows reports a vanished pipe reader as EINVAL (or EPIPE) instead
        # of BrokenPipeError. Those stream-write failures carry no filename,
        # so treat only that shape as a broken pipe. A genuine filesystem
        # EINVAL (e.g. a bad path during export) has e.filename set and must
        # stay visible instead of vanishing as a silent exit.
        if e.errno in (errno.EINVAL, errno.EPIPE) and e.filename is None:
            os._exit(1)
        traceback.print_exc()
        return 4
    except Exception:
        # Unexpected crash. Exit 4 is distinct from the handled codes (1 = no
        # match, 2 = bad usage/validation, 3 = abort/collision) so the GUI
        # can classify crashes.
        traceback.print_exc()
        return 4


if __name__ == "__main__":
    raise SystemExit(main())
