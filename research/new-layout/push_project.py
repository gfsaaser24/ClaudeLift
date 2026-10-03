"""Reference implementation: rebuild one saved claude.ai project as a
new-layout project ("channel") in the account Claude Desktop is signed in to.

Proven live on 2026-10-03 with "Copywriting with Faris" (see
docs/NEW-LAYOUT-SPEC.md). This is the research version that drives Claude
Desktop's claude.ai page through its Main Process Debugger; the product
version belongs in the engine/app (spec section 6).

Usage (Claude Desktop: Developer -> Enable Main Process Debugger first):
    python push_project.py "<claude-account>/projects/<Name> (<id8>)" [--dry-run] [--no-chats] > page.js
    python inpage.py page.js main.js
    node cdp-main.mjs main.js

What it writes (unless --dry-run):
    1. POST  /v1/code/channels                      create the project (skipped if the name exists)
    2. PATCH /v1/code/channels/{id}/config          system_prompt_addendum = instructions (<= 16,000 chars)
    3. POST  /api/{org}/upload?store_as_is=true     one upload per Library file
       POST  /v1/code/channels/{id}/files:write     batches of 25, ids = file_01 + base58(uuid) padded to 22
    4. POST  /v1/code/memory/channel/{id}/memories  one per memory note, precondition {type: not_exists},
                                                    credentials blanked (the store rejects secrets)
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from cowork_export import blank_secrets  # noqa: E402  (shared credential blanking)

INSTRUCTIONS_MAX = 16000
SECRET = re.compile(
    r"AIza[0-9A-Za-z_\-]{35}|sk-ant-[0-9A-Za-z_\-]{20,}|sk-[A-Za-z0-9_\-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}"
    r"|xox[abprs]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"
)
SKIP_MEMORY = {"cloud-memory.json"}  # duplicate of cloud-memory.md
MEMORY_RENAME = {"cloud-memory.md": "project-memory.md"}


def safe(s: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", s).strip(". ") or "untitled"


def build_payload(project_dir: Path, include_chats: bool) -> dict:
    meta = json.loads((project_dir / "project.json").read_text(encoding="utf-8"))
    account_root = project_dir.parent.parent  # .../claude-account
    instructions, _n = blank_secrets(meta.get("prompt_template") or "")
    library: list[dict] = []

    def add(rel: str, path: Path) -> None:
        data = path.read_bytes()
        if b"\0" not in data[:8192]:  # text: never upload credentials
            text, _n = blank_secrets(data.decode("utf-8", errors="surrogateescape"))
            data = text.encode("utf-8", errors="surrogateescape")
        mime = mimetypes.guess_type(path.name)[0] or ("text/markdown" if path.suffix == ".md" else "application/octet-stream")
        library.append({"path": rel, "name": path.name, "mime": mime, "b64": base64.b64encode(data).decode()})

    for sub in ("docs", "files"):
        d = project_dir / sub
        if d.is_dir():
            for p in sorted(d.rglob("*")):
                if p.is_file():
                    rel = p.relative_to(d).as_posix()
                    add(rel if sub == "docs" else f"files/{rel}", p)
    if len(instructions) > INSTRUCTIONS_MAX:
        # Too long for the instructions field: keep the start there and the
        # full text in the Library.
        add("INSTRUCTIONS (full).md", project_dir / "INSTRUCTIONS.md")
        instructions = instructions[: INSTRUCTIONS_MAX - 80] + "\n\n[Continued in the Library: INSTRUCTIONS (full).md]"

    if include_chats:
        idx_files = list((account_root / "account").glob("*/chats-index.json"))
        seen: set[str] = set()
        for idx_file in idx_files:
            for c in json.loads(idx_file.read_text(encoding="utf-8")):
                if c.get("project_uuid") != meta["uuid"]:
                    continue
                md = account_root / "conversations" / c["uuid"] / "session.md"
                if not md.exists():
                    continue
                name = f"{(c.get('updated_at') or '')[:10]} {safe(c.get('name') or 'Untitled chat')}"[:120] + ".md"
                while name.lower() in seen:
                    name = name[:-3] + " (2).md"
                seen.add(name.lower())
                add(f"chats/{name}", md)

    memory = []
    for p in sorted((project_dir / "memory").glob("*")) if (project_dir / "memory").is_dir() else []:
        if not p.is_file() or p.name in SKIP_MEMORY or not p.stat().st_size:
            continue
        text, n = blank_secrets(p.read_text(encoding="utf-8", errors="replace"))
        memory.append({"path": "/" + MEMORY_RENAME.get(p.name, p.name), "content": text, "redacted": n})
    return {"name": meta.get("name") or project_dir.name, "instructions": instructions, "library": library, "memory": memory}


PAGE = r"""
(async () => {
  const P = __PAYLOAD__
  const DRY = __DRY__
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  // 16-byte uuid -> fixed-width 22-char base58 (left-pad '1'), e.g. file_01..., user_01...
  const tagged = (prefix, uuid) => { let n = BigInt('0x' + uuid.replace(/-/g, '')), s = ''; while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n } return prefix + '_01' + s.padStart(22, '1') }
  const orgs = await (await fetch('/api/organizations')).json()
  const org = orgs.find((o) => (o.capabilities || []).includes('chat')) || orgs[0]
  const H = { 'content-type': 'application/json', accept: 'application/json', 'anthropic-version': '2023-06-01',
              'anthropic-beta': 'ccr-byoc-2025-07-29', 'x-organization-uuid': org.uuid }
  const call = async (method, url, body) => { const r = await fetch(url, { method, credentials: 'include', headers: H, body: body && JSON.stringify(body) }); let j = null; try { j = await r.json() } catch (_) {} return { ok: r.ok, status: r.status, j } }
  const res = { account_org: org.name, project: P.name, library_planned: P.library.length, memory_planned: P.memory.length,
                instructions_chars: P.instructions.length, steps: [] }
  const list = await call('GET', '/v1/code/channels?scope=all')
  const existing = ((list.j && list.j.data) || []).find((c) => c.name === P.name && !c.archived_at)
  if (DRY) { res.would = existing ? 'skip: a project with this name exists (' + existing.id + ')' : 'create'; return res }
  if (existing) { res.steps.push({ step: 'create', skipped: 'name exists', chan: existing.id }); return res }
  const c = await call('POST', '/v1/code/channels', { name: P.name, visibility: 'private', context_sources: [] })
  if (!c.ok) { res.steps.push({ step: 'create', status: c.status, err: c.j }); return res }
  const chan = c.j.channel.id; res.chan = chan
  if (P.instructions) {
    const cfg = await call('PATCH', `/v1/code/channels/${chan}/config`, { system_prompt_addendum: P.instructions })
    res.steps.push({ step: 'instructions', status: cfg.status, err: cfg.ok ? null : cfg.j })
  }
  const entries = [], failed = []
  for (const f of P.library) {
    const bytes = Uint8Array.from(atob(f.b64), (ch) => ch.charCodeAt(0))
    const fd = new FormData(); fd.append('file', new File([bytes], f.name, { type: f.mime }))
    const u = await fetch(`/api/${org.uuid}/upload?store_as_is=true`, { method: 'POST', credentials: 'include', body: fd })
    let j = null; try { j = await u.json() } catch (_) {}
    if (u.ok && j && j.file_uuid) entries.push({ path: f.path, source_file_id: tagged('file', j.file_uuid) })
    else failed.push({ path: f.path, step: 'upload', status: u.status })
  }
  let written = 0
  for (let i = 0; i < entries.length; i += 25) {
    const batch = entries.slice(i, i + 25)
    let w = await call('POST', `/v1/code/channels/${chan}/files:write`, { files: batch })
    if (!w.ok) {  // one bad entry rejects the whole batch: retry one by one
      for (const e of batch) { const one = await call('POST', `/v1/code/channels/${chan}/files:write`, { files: [e] }); if (one.ok) written++; else failed.push({ path: e.path, step: 'write', status: one.status, err: one.j }) }
      continue
    }
    for (const r of (w.j && w.j.results) || []) { if (r.entry) written++; else failed.push({ path: r.path, step: 'write', err: r.error }) }
  }
  res.steps.push({ step: 'library', written, failed })
  const mem = []
  for (const m of P.memory) {
    const r = await call('POST', `/v1/code/memory/channel/${chan}/memories`, { path: m.path, content: m.content, precondition: { type: 'not_exists' } })
    mem.push({ path: m.path, redacted: m.redacted, status: r.status, err: r.ok ? null : r.j })
  }
  res.steps.push({ step: 'memory', notes: mem })
  // Read back what is there now.
  const fl = await call('POST', `/v1/code/channels/${chan}/files:list`, { recursive: true, limit: 500 })
  const ml = await call('GET', `/v1/code/memory/channel/${chan}/memories`)
  res.verify = { library_files: ((fl.j && fl.j.entries) || []).filter((e) => !e.is_directory).length, memory_files: ((ml.j && ml.j.data) || []).length }
  return res
})()
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("project_dir")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-chats", action="store_true")
    a = ap.parse_args()
    payload = build_payload(Path(a.project_dir), include_chats=not a.no_chats)
    print(PAGE.replace("__PAYLOAD__", json.dumps(payload)).replace("__DRY__", "true" if a.dry_run else "false"))


if __name__ == "__main__":
    main()
