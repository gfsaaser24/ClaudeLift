#!/usr/bin/env python3
"""Self-test for the claude.ai → Cowork path. Stdlib only.

Builds a fake claude.ai data export (conversations / projects / memories zips)
and a fake live pull file (scripts/pull-claude-projects.js output, version 2)
in a temp dir, then runs the engine as a subprocess with HOME, APPDATA and
LOCALAPPDATA pointed into that temp dir, so no real Claude data is read or
written:

  1. `convert-claudeai <export> --pull <file>` → exit 0; projects get their
     instructions, docs, uploaded files (base64 decoded, incl. a CSV "blob"),
     memory; account/ gets profile.md; a chat linked to a project in the pull's
     chat list carries space/space.json; a chat that only the pull has is
     converted too
  2. `import-all <out> --cowork-root <fake>` → exit 0; spaces.json holds one
     space per project; imported tasks point at the right space; transcripts
     sit under .claude/projects/session/
  3. `convert-claudeai --pull <file>` with no export folder → exit 0

Usage: py -3.14 tests\\claudeai_selftest.py
"""
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ENGINE = REPO / "cowork_export.py"
FAILURES: list[str] = []

ORG = "11111111-1111-1111-1111-111111111111"
PROJ = "22222222-2222-2222-2222-222222222222"
PROJ_LIVE_ONLY = "33333333-3333-3333-3333-333333333333"
CHAT_IN_PROJ = "44444444-4444-4444-4444-444444444444"
CHAT_PLAIN = "55555555-5555-5555-5555-555555555555"
CHAT_LIVE_ONLY = "66666666-6666-6666-6666-666666666666"


def check(cond: bool, msg: str) -> bool:
    print(f"  {'ok  ' if cond else 'FAIL'}: {msg}")
    if not cond:
        FAILURES.append(msg)
    return cond


def chat(uuid: str, name: str, text: str) -> dict:
    return {
        "uuid": uuid, "name": name, "summary": "", "created_at": "2026-09-01T10:00:00Z",
        "updated_at": "2026-09-02T10:00:00Z", "account": {"uuid": "acct"},
        "chat_messages": [
            {"uuid": uuid[:8] + "-u", "text": text, "sender": "human", "created_at": "2026-09-01T10:00:00Z",
             "content": [{"type": "text", "text": text}], "attachments": [], "files": []},
            {"uuid": uuid[:8] + "-a", "text": "", "sender": "assistant", "created_at": "2026-09-01T10:00:05Z",
             "content": [{"type": "thinking", "thinking": "hmm"},
                         {"type": "tool_use", "id": None, "name": "artifacts",
                          "input": {"command": "create", "title": "Plan", "content": "# The plan"}},
                         {"type": "text", "text": "Here is the plan."}],
             "attachments": [], "files": []},
        ],
    }


def build_fixtures(root: Path) -> tuple[Path, Path]:
    export = root / "export"
    export.mkdir()
    with zipfile.ZipFile(export / "conversations-000.zip", "w") as z:
        z.writestr("conversations.json", json.dumps([
            chat(CHAT_IN_PROJ, "Coach copy draft", "Write the hook"),
            chat(CHAT_PLAIN, "Random question", "What is 2+2"),
        ]))
    with zipfile.ZipFile(export / "projects-000.zip", "w") as z:
        z.writestr(f"projects/{PROJ}.json", json.dumps({
            "uuid": PROJ, "name": "Copywriting Coach", "description": "copy", "is_private": True,
            "prompt_template": "Write like the coach.", "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-02-01T00:00:00Z", "creator": {"uuid": "acct", "full_name": "Sam"},
            "docs": [{"uuid": "d1", "filename": "Content Output Rules", "content": "No fluff."}],
        }))
    with zipfile.ZipFile(export / "memories-000.zip", "w") as z:
        z.writestr("memories/acct.json", json.dumps({
            "conversations_memory": "Sam runs Acme Detailing.", "account_uuid": "acct",
            "project_memories": {PROJ: "Coach project summary."},
            "memory_files": [
                {"path": f"/projects/{PROJ}/editorial-standards.md", "content": "Be plain.", "updated_at": ""},
                {"path": "/areas/sales.md", "content": "Sales notes.", "updated_at": ""},
            ],
        }))
    # A Cowork plugin installed in the org, as Claude Desktop stores it.
    rpm = (root / "home" / "AppData" / "Local" / "Packages" / "Claude_test" / "LocalCache" / "Roaming"
           / "Claude" / "local-agent-mode-sessions" / "acct" / ORG / "rpm")
    plugin = rpm / "plugin_abc"
    (plugin / ".claude-plugin").mkdir(parents=True)
    (plugin / ".claude-plugin" / "plugin.json").write_text(json.dumps({"name": "my-plugin"}), encoding="utf-8")
    (plugin / ".mcp.json").write_text(json.dumps({"mcpServers": {"x": {"env": {"API_KEY": "sk-literal"}}}}), encoding="utf-8")
    (plugin / "skills" / "s").mkdir(parents=True)
    (plugin / "skills" / "s" / "SKILL.md").write_text("# s", encoding="utf-8")
    (rpm / "manifest.json").write_text(json.dumps({"plugins": [
        {"id": "plugin_abc", "name": "my-plugin", "marketplaceName": "My Uploads", "installedBy": "user"}]}),
        encoding="utf-8")
    pull = root / "claudelift-pull-test.json"
    pull.write_text(json.dumps({
        "tool": "claudelift-project-pull", "version": 2, "pulled_at": "2026-10-02T00:00:00Z",
        "account": {"profile": {"conversation_preferences": "Plain English.", "cowork_global_instructions": "Be brief."}},
        "organizations": [
            {"uuid": "api-org", "name": "API org", "projects": [], "errors": ["403 /api/..."]},
            {"uuid": ORG, "name": "Sam P", "errors": [],
             "memory": {"memory": "Live memory text."}, "memory_settings": {"enabled": True},
             "skills": [{"id": "s1", "name": "my-skill"}], "styles": {"defaultStyles": []},
             "connectors": [{"name": "Asana", "url": "https://mcp.asana.com/v2/mcp"}],
             "chats": [{"uuid": CHAT_IN_PROJ, "name": "Coach copy draft", "project_uuid": PROJ},
                       {"uuid": CHAT_PLAIN, "name": "Random question", "project_uuid": None},
                       {"uuid": CHAT_LIVE_ONLY, "name": "New since export", "project_uuid": PROJ_LIVE_ONLY}],
             "chat_bodies": [chat(CHAT_LIVE_ONLY, "New since export", "Fresh chat")],
             "projects": [
                 {"uuid": PROJ, "listed": {"name": "Copywriting Coach"},
                  "project": {"name": "Copywriting Coach", "prompt_template": "Write like the coach."},
                  "docs": [{"uuid": "d1", "file_name": "Content Output Rules", "content": "No fluff."},
                           {"uuid": "d2", "file_name": "New Doc", "content": "Added after the export."}],
                  "files": [
                      {"meta": {"file_uuid": "f1", "file_name": "brief.pdf", "file_kind": "document"},
                       "data": {"base64": base64.b64encode(b"%PDF-1.4 brief").decode()}},
                      {"meta": {"file_uuid": "f2", "file_name": "leads.csv", "file_kind": "blob"},
                       "data": {"base64": base64.b64encode(b"name,phone\nA,1\n").decode()}},
                  ],
                  "syncs": [], "memory": {"memory": ""}},
                 {"uuid": PROJ_LIVE_ONLY, "listed": {"name": "Live Only Project", "prompt_template": "Be live."},
                  "project": {"name": "Live Only Project", "prompt_template": "Be live."},
                  "docs": [], "files": [], "syncs": [], "memory": {"memory": ""}},
             ]},
        ],
    }), encoding="utf-8")
    return export, pull


def run_engine(home: Path, *args: str) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env.update({
        "USERPROFILE": str(home), "HOME": str(home),
        "APPDATA": str(home / "AppData" / "Roaming"), "LOCALAPPDATA": str(home / "AppData" / "Local"),
        "PYTHONIOENCODING": "utf-8",
    })
    return subprocess.run([sys.executable, str(ENGINE), *args], capture_output=True, text=True,
                          encoding="utf-8", env=env, cwd=str(REPO), timeout=300)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="claudelift-cai-") as tmp:
        root = Path(tmp)
        home = root / "home"
        (home / "Downloads").mkdir(parents=True)
        export, pull = build_fixtures(root)
        out = root / "out"

        print("[1] convert-claudeai with export + pull")
        r = run_engine(home, "convert-claudeai", str(export), "--pull", str(pull), "-o", str(out),
                       "--what", "conversations,projects,memory,account")
        check(r.returncode == 0, f"exit 0 (got {r.returncode}; stderr: {r.stderr[-400:]})")
        proj = next((out / "projects").glob("Copywriting Coach (*"), None)
        check(proj is not None, "project folder named after the project")
        if proj:
            check((proj / "INSTRUCTIONS.md").read_text(encoding="utf-8").count("Write like the coach.") == 1, "instructions saved")
            check((proj / "docs" / "Content Output Rules.md").is_file(), "export doc saved with .md")
            check((proj / "docs" / "New Doc.md").is_file(), "doc only the pull has is added")
            check((proj / "files" / "brief.pdf").read_bytes() == b"%PDF-1.4 brief", "uploaded PDF decoded")
            check((proj / "files" / "leads.csv").read_bytes() == b"name,phone\nA,1\n", "CSV blob decoded")
            check((proj / "memory" / "editorial-standards.md").is_file(), "project memory saved")
        check(any((out / "projects").glob("Live Only Project (*")), "project only the pull has is saved")
        check("Plain English." in (out / "account" / "profile.md").read_text(encoding="utf-8"), "profile.md has preferences")
        check((out / "memory" / "areas" / "sales.md").is_file(), "account memory saved")
        org_dir = next((out / "account").glob("Sam P (*"), None)
        zp = org_dir / "plugins-upload" / "my-plugin.zip" if org_dir else None
        check(zp is not None and zp.is_file(), "plugin zipped for upload")
        if zp is not None and zp.is_file():
            with zipfile.ZipFile(zp) as z:
                check(".claude-plugin/plugin.json" in z.namelist(), "plugin.json at the zip root")
            pj = json.loads((org_dir / "plugins.json").read_text(encoding="utf-8"))
            check(pj[0]["contains_literal_secret"] and pj[0]["uploaded_by_you"], "plugin flags (secret, your upload)")
        guide = (out / "account" / "REINSTALL.md").read_text(encoding="utf-8") if (out / "account" / "REINSTALL.md").exists() else ""
        check("my-plugin.zip" in guide and "Asana" in guide, "REINSTALL.md lists plugins and connectors")
        sp = out / "conversations" / CHAT_IN_PROJ / "space" / "space.json"
        check(sp.is_file() and json.loads(sp.read_text(encoding="utf-8"))["name"] == "Copywriting Coach",
              "project chat carries its project as space")
        check(not (out / "conversations" / CHAT_PLAIN / "space").exists(), "plain chat has no space")
        check((out / "conversations" / CHAT_LIVE_ONLY / "transcript.jsonl").is_file(), "chat only the pull has is converted")
        tr = (out / "conversations" / CHAT_IN_PROJ / "transcript.jsonl").read_text(encoding="utf-8")
        check("# The plan" in tr and '"thinking"' not in tr, "artifact body kept, thinking not replayed")

        print("[2] import-all into a fake account")
        cowork = root / "cowork"
        ws = cowork / "acct2" / "org2"
        ws.mkdir(parents=True)
        (ws / "local_seed.json").write_text(json.dumps({
            "sessionId": "local_seed", "processName": "seed", "cwd": "x", "createdAt": 1, "lastActivityAt": 1,
            "emailAddress": "new@example.com", "accountName": "New"}), encoding="utf-8")
        r = run_engine(home, "import-all", str(out), "--cowork-root", str(cowork),
                       "--docs-root", str(root / "docs"), "--allow-running")
        check(r.returncode == 0, f"exit 0 (got {r.returncode}; stdout: {r.stdout[-400:]} stderr: {r.stderr[-400:]})")
        spaces = json.loads((ws / "spaces.json").read_text(encoding="utf-8"))["spaces"] if (ws / "spaces.json").exists() else []
        by_name = {s["name"]: s for s in spaces}
        check("Copywriting Coach" in by_name and "Live Only Project" in by_name, "one space per project")
        check("Account memory (imported)" in by_name, "account memory space")
        tasks = [json.loads(p.read_text(encoding="utf-8")) for p in ws.glob("local_*.json") if p.name != "local_seed.json"]
        check(len(tasks) == 3, f"3 chats imported as tasks (got {len(tasks)})")
        coach_task = next((t for t in tasks if t.get("title") == "Coach copy draft"), {})
        check(coach_task.get("spaceId") == by_name.get("Copywriting Coach", {}).get("id"), "project chat filed under its space")
        check(coach_task.get("emailAddress") == "new@example.com", "task takes the target account identity")
        check(all(t.get("cwd") and t.get("processName") and t.get("createdAt") for t in tasks), "required task fields set")
        check(len(list(ws.glob("local_*/.claude/projects/session/*.jsonl"))) == 3, "transcripts under projects/session")
        check((root / "docs" / "Copywriting Coach" / "files" / "leads.csv").is_file(), "project files copied to space folder")

        print("[3] convert-claudeai with only --pull")
        r = run_engine(home, "convert-claudeai", "--pull", str(pull), "-o", str(root / "out2"), "--what", "projects,account")
        check(r.returncode == 0, f"exit 0 (got {r.returncode}; stderr: {r.stderr[-400:]})")
        check(len(list((root / "out2" / "projects").glob("*/INSTRUCTIONS.md"))) == 2, "both pulled projects saved")

    print()
    if FAILURES:
        print(f"SELFTEST FAILED — {len(FAILURES)} failure(s):")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("SELFTEST PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
