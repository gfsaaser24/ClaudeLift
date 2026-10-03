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


FAKE_KEY = "AIza" + "Z" * 35  # built at runtime: not a real key
DUP_A, DUP_B = "aaaaaaaa-0000-0000-0000-000000000001", "bbbbbbbb-0000-0000-0000-000000000002"


def build_converted(src: Path) -> Path:
    """A small convert-claudeai output folder plus Cowork task bundles."""
    def w(path: Path, data: str | bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data) if isinstance(data, bytes) else path.write_text(data, encoding="utf-8")

    def proj(folder: str, **meta) -> Path:
        d = src / "projects" / folder
        w(d / "project.json", json.dumps(meta))
        return d

    a = proj("Dup (aaaaaaaa)", uuid=DUP_A, name="Dup", org="Org A", created_at="2026-01-01T00:00:00Z",
             prompt_template="Long rules. " * 1500 + f"key {FAKE_KEY}")
    w(a / "docs" / "a.md", f"doc with {FAKE_KEY} inside\n")
    w(a / "docs" / "b.pdf", b"%PDF-1.4\x00binary " + FAKE_KEY.encode())
    w(a / "docs" / "words.md", "task-management-and-planning and risk-assessment-framework-v2\n"
                               "my api key is in the vault\n"
                               "OPENAI_API_KEY=abcdefgh12345678\n"
                               "db: postgres://admin:hunter2pass@db.example.com/app\n")
    w(a / "files" / ".env.local", f"GEMINI={FAKE_KEY}\n")
    w(a / "files" / "id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\n")
    w(a / "files" / "latin1.txt", b"caf\xe9 " + FAKE_KEY.encode() + b"\n")
    w(a / "files" / "utf16.txt", ("key " + FAKE_KEY + "\n").encode("utf-16"))
    w(a / "files" / "x.csv", "n,v\n1,2\n")
    w(a / "memory" / "cloud-memory.json", "{}")
    w(a / "memory" / "cloud-memory.md", f"memory {FAKE_KEY}\n")
    w(a / "memory" / "note.md", "a note\n")
    w(a / "memory" / "empty.md", "")
    proj("Dup (bbbbbbbb)", uuid=DUP_B, name="Dup", org="Org A", created_at="2026-02-01T00:00:00Z",
         prompt_template="space rules", _pull={"project": {"cowork_bound_device": {"local_space_id": "space-1"}}})
    proj("Other (cccccccc)", uuid="cccccccc-0000-0000-0000-000000000003", name="Other", org="Org B",
         prompt_template="other org", _pull={"project": {"cowork_bound_device": {"local_space_id": "space-b"}}})
    proj("Plain (eeeeeeee)", uuid="eeeeeeee-0000-0000-0000-000000000005", name="Plain", org="Org A",
         created_at="2026-05-01T00:00:00Z", prompt_template="newer")
    proj("Plain (ffffffff)", uuid="ffffffff-0000-0000-0000-000000000006", name="Plain", org="Org A",
         created_at="2026-04-01T00:00:00Z", prompt_template="older")
    proj("Empty (dddddddd)", uuid="dddddddd-0000-0000-0000-000000000004", name="Empty", org="Org A")
    rows = [
        {"uuid": "c1", "name": "Hello", "updated_at": "2026-03-01T10:00:00Z", "project_uuid": DUP_A},
        {"uuid": "c2", "name": "Hello", "updated_at": "2026-03-01T11:00:00Z", "project_uuid": DUP_A},
        {"uuid": "c3", "name": "Loose chat", "updated_at": "2026-03-02T10:00:00Z", "project_uuid": None},
    ]
    w(src / "account" / "Org A (11111111)" / "chats-index.json", json.dumps(rows))
    w(src / "account" / "Org A (11111111)" / "memory.md", "account memory A\n")
    w(src / "account" / "Org B (22222222)" / "chats-index.json",
      json.dumps([{"uuid": "c4", "name": "B chat", "updated_at": "2026-03-03T10:00:00Z", "project_uuid": None},
                  {"uuid": "c5", "name": "Other chat", "updated_at": "2026-03-04T10:00:00Z",
                   "project_uuid": "cccccccc-0000-0000-0000-000000000003"}]))
    w(src / "account" / "Org B (22222222)" / "memory.md", "account memory B\n")
    for c in ("c1", "c2", "c3", "c4", "c5"):
        w(src / "conversations" / c / "session.md", f"# chat {c}\n")
    w(src / "memory" / "areas" / "sales.md", "sales memory\n")
    bundles = src.parent / "bundles"
    for tid, sid, sname, title in (("t1", "space-1", "Dup", "Task one"), ("t2", "", "", "Loose task"),
                                   ("t3", "zzz", "Dup", "Task three"),
                                   ("t4", "space-b", "Other", "Other task"), ("t5", "yyy", "Other", "Other by name")):
        w(bundles / tid / "manifest.json", json.dumps({"source_space_id": sid, "source_space_name": sname}))
        w(bundles / tid / "task.json", json.dumps({"title": title, "createdAt": "1780000000000"}))
        w(bundles / tid / "session.md", f"# {title}\n")
    return bundles


def test_plan_push(src: Path, home: Path) -> None:
    bundles = build_converted(src)
    plan_file = src.parent / "plan" / "plan.json"
    r = run_engine(home, "plan-push", "--source", str(src), "--cowork-bundles", str(bundles), "--org", "Org A",
                   "--include-unfiled-chats", "--out", str(plan_file))
    check(r.returncode == 0, f"exit 0 (got {r.returncode}; stderr: {r.stderr[-400:]})")
    check(FAKE_KEY not in r.stdout + r.stderr, "key never printed")
    try:
        done = json.loads(r.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError):
        done = {}
    check(done.get("event") == "done" and done.get("plan") == str(plan_file.resolve()), "done line names the plan")
    raw = plan_file.read_text(encoding="utf-8") if plan_file.exists() else "{}"
    plan = json.loads(raw)
    check(FAKE_KEY not in raw, "no key in the plan")
    check(plan.get("plan_version") == 1 and {"projects", "skipped", "totals", "options", "source"} <= set(plan),
          "plan shape")
    by = {p["name"]: p for p in plan.get("projects", [])}
    keys = {"key", "name", "source_name", "org", "kind", "instructions", "library", "memory", "counts", "warnings", "empty"}
    check(all(keys <= set(p) for p in by.values()), "every project has the full key set")
    check({"Dup", "Dup (Cowork)"} <= set(by), "a Cowork space that collides gets (Cowork)")
    check(by.get("Plain", {}).get("key", "").startswith("ffffffff") and "Plain (2)" in by,
          "same-named plain projects: the older keeps the name, the newer gets (2)")
    check(by.get("Dup", {}).get("key") == DUP_A and by.get("Dup (Cowork)", {}).get("kind") == "cowork-space",
          "names follow created_at; space-bound project is a cowork-space")
    skipped = {s["name"]: s["reason"] for s in plan.get("skipped", [])}
    check("Other" in skipped and "Other" not in by, "other org skipped")
    check("Empty" in skipped and "Empty" not in by, "empty project skipped")
    d = by.get("Dup", {})
    lib = {e["path"]: e for e in d.get("library", [])}
    check(len(d.get("instructions", "")) <= 16000 and d.get("instructions", "").endswith(
        "[Continued in the Library: INSTRUCTIONS (full).md]"), "long instructions cut with a pointer")
    full = lib.get("INSTRUCTIONS (full).md")
    check(bool(full) and Path(full["file"]).read_text(encoding="utf-8").startswith("Long rules.")
          and FAKE_KEY not in Path(full["file"]).read_text(encoding="utf-8"), "full instructions in the Library, blanked")
    a = lib.get("a.md")
    check(bool(a) and Path(a["file"]).parent.parent.name == "plan.staging" and len(Path(a["file"]).name) <= 8
          and FAKE_KEY not in Path(a["file"]).read_text(encoding="utf-8")
          and "[API key removed by ClaudeLift]" in Path(a["file"]).read_text(encoding="utf-8"),
          "text doc with a key goes up as a blanked copy")
    check(bool(lib.get("b.pdf")) and ".staging" not in lib["b.pdf"]["file"] and lib["b.pdf"]["mime"] == "application/pdf",
          "binary doc goes up from its own file")
    check("files/x.csv" in lib, "uploaded files go under files/")
    check({"chats/2026-03-01 Hello.md", "chats/2026-03-01 Hello (2).md"} <= set(lib), "chats mapped, paths kept unique")
    check(d.get("counts", {}).get("keys_removed", 0) >= 3 and any("credential" in x for x in d.get("warnings", [])),
          "keys counted and warned")
    mem = {m["path"]: m for m in d.get("memory", [])}
    check(set(mem) == {"/project-memory.md", "/note.md"}, f"memory: renamed, json and empty notes left out ({sorted(mem)})")
    check(mem.get("/project-memory.md", {}).get("redacted") == 1, "memory note key blanked and counted")
    cw = {e["path"] for e in by.get("Dup (Cowork)", {}).get("library", [])}
    check(any(p.endswith(" Task one.md") and p.startswith("cowork/") for p in cw), "Cowork task mapped by space id")
    check(any(p.endswith(" Task three.md") for p in cw), "Cowork task mapped by space name when the id is unknown")
    hist = {e["path"] for e in by.get("Cowork history (imported)", {}).get("library", [])}
    check(any(p.endswith(" Loose task.md") for p in hist), "task with no space goes to Cowork history")
    ch = {e["path"] for e in by.get("Chat history (imported)", {}).get("library", [])}
    check(ch == {"chats/2026-03-02 Loose chat.md"}, f"unfiled chats of the chosen org only ({sorted(ch)})")
    am = {m["path"] for m in by.get("Account memory (imported)", {}).get("memory", [])}
    check(am == {"/areas/sales.md", "/account-memory-Org A.md"}, f"account memory of the chosen org ({sorted(am)})")
    r = run_engine(home, "plan-push", "--source", str(src), "--org", "Org A", "--projects", "Dup (Cowork)",
                   "--no-account-memory", "--out", str(plan_file.with_name("plan2.json")))
    names = [p["name"] for p in json.loads(plan_file.with_name("plan2.json").read_text(encoding="utf-8"))["projects"]] if r.returncode == 0 else []
    check(names == ["Dup (Cowork)"], f"--projects picks by plan name ({names})")
    check(Path(a["file"]).is_file() if a else False, "a second plan in the same folder keeps the first plan's copies")

    words = lib.get("words.md")
    wt = Path(words["file"]).read_text(encoding="utf-8") if words else ""
    check("task-management-and-planning" in wt and "risk-assessment-framework-v2" in wt,
          "words that contain sk- stay intact")
    check("my api key is in the vault" in wt, "plain lowercase text about keys stays intact")
    check("OPENAI_API_KEY=[API key removed by ClaudeLift]" in wt and "abcdefgh12345678" not in wt,
          "env-style line: name kept, value blanked")
    check("postgres://admin:[API key removed by ClaudeLift]@db.example.com" in wt and "hunter2pass" not in wt,
          "URL password blanked, user and host kept")
    for rel in ("files/.env.local", "files/id_rsa", "files/latin1.txt", "files/utf16.txt"):
        e = lib.get(rel)
        raw_b = Path(e["file"]).read_bytes() if e else b""
        check(bool(e) and ".staging" in e["file"] and FAKE_KEY.encode() not in raw_b
              and FAKE_KEY.encode("utf-16-le") not in raw_b and b"b3BlbnNzaC1rZXk" not in raw_b,
              f"{rel}: scanned by content and blanked")
    lat = lib.get("files/latin1.txt")
    check(bool(lat) and Path(lat["file"]).read_bytes().startswith(b"caf\xe9 "), "non-UTF-8 bytes written back as they were")
    u16 = lib.get("files/utf16.txt")
    check(bool(u16) and "[API key removed by ClaudeLift]" in Path(u16["file"]).read_bytes().decode("utf-16"),
          "UTF-16 text blanked and kept UTF-16")
    sk = {x["name"]: x["reason"] for x in plan.get("skipped", [])}
    check("1 chat(s) of Other" in sk and "2 Cowork task(s) of Other" in sk,
          f"chats and Cowork tasks of a skipped project are reported ({sorted(sk)})")
    allpaths = {e["path"] for p in plan.get("projects", []) for e in p["library"]}
    check(not any("Other" in x for x in allpaths), "tasks of a skipped project are not moved to another project")


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

        print("[4] plan-push on a converted folder")
        test_plan_push(root / "plan-src", home)

        print("[5] Library paths are cleaned")
        sys.path.insert(0, str(REPO))
        from claudeai_export import clean_library_path
        garbled = "Talkin\u00e2\u0080\u0099 Paint Ep. 24.docx"
        check(clean_library_path(garbled) == "Talkin\u2019 Paint Ep. 24.docx", "garbled UTF-8 repaired")
        check(clean_library_path("files/a\u0007b\u009d.md") == "files/ab.md", "control characters removed")
        check(clean_library_path("Caf\u00e9 notes.md") == "Caf\u00e9 notes.md", "real accents kept")
        check(clean_library_path("chats/\u0001/x.md") == "chats/untitled/x.md", "empty segment named untitled")

        print("[6] linked PC folder goes into the Library under its name")
        from claudeai_export import _PlanProject
        lf = root / "Brain Folder"
        (lf / "sub").mkdir(parents=True)
        (lf / ".obsidian").mkdir()
        (lf / "node_modules").mkdir()
        (lf / "a.md").write_text("hello", encoding="utf-8")
        (lf / "sub" / "b.txt").write_text("key=" + "AIza" + "B" * 35, encoding="utf-8")
        (lf / ".obsidian" / "x.json").write_text("{}", encoding="utf-8")
        (lf / "node_modules" / "y.js").write_text("", encoding="utf-8")
        (lf / "~$lock.docx").write_bytes(b"x")
        pp = _PlanProject("k", "P", "P", None, "cowork-space", root / "stage-lf")
        pp.add_local_folder(str(lf))
        pp.add_local_folder(str(root / "missing-folder"))
        paths = sorted(e["path"] for e in pp.library)
        check(paths == ["Brain Folder/a.md", "Brain Folder/sub/b.txt"], f"only real files, under the folder name ({paths})")
        check(pp.context_sources == [{"kind": "local_folder", "name": "Brain Folder", "path": str(lf)}], "folder recorded")
        check(pp.counts["folder"] == 2 and pp.counts["keys_removed"] == 1, "counted, key blanked")
        b = next(e for e in pp.library if e["path"].endswith("b.txt"))
        check("AIza" not in Path(b["file"]).read_text(encoding="utf-8"), "uploaded copy has no key")
        check(any("not found" in w for w in pp.warnings), "missing folder warned")

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
