#!/usr/bin/env python3
"""Self-test for the cowork_export.py engine patches (Task 1). Stdlib only.

Runs the engine as a subprocess against the REAL local Cowork data, the
same way the Electron app will:

  1. `list --json`               -> exit 0, stdout is a single JSON array,
                                    every element carries the full key set
  2. `list --json --source code` -> exit 0, stdout is a JSON array
  3. `export <task> --progress-json --no-files -o <tmp> --formats md`
                                 -> every stdout line parses as JSON with an
                                    "event" key; last event is "done"
  4. piped output with PYTHONIOENCODING unset (cp1252 console simulation)
                                 -> no crash, stdout stays valid UTF-8
  5. an unexpected exception in a command exits 4 with a traceback on stderr
  6. OSError EINVAL scoping: filesystem EINVAL (filename set) is visible and
     exits 4; stream-write EINVAL (no filename) keeps the quiet exit 1

Usage: py -3.14 tests\\engine_selftest.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ENGINE = REPO / "cowork_export.py"

LIST_KEYS = {
    "task_id", "source", "title", "model", "space_name", "cwd",
    "created_at_ms", "last_activity_ms", "archived", "error",
    "has_transcript", "transcript_path", "task_dir", "task_meta_file",
}

FAILURES: list[str] = []


def check(cond: bool, msg: str) -> bool:
    print(f"  {'ok  ' if cond else 'FAIL'}: {msg}")
    if not cond:
        FAILURES.append(msg)
    return cond


def run_engine(*args: str) -> subprocess.CompletedProcess:
    """Run the engine with pipes and WITHOUT PYTHONIOENCODING / PYTHONUTF8,
    so the engine's own win32 utf-8 reconfigure is what must keep a cp1252
    console with piped output alive."""
    env = os.environ.copy()
    env.pop("PYTHONIOENCODING", None)
    env.pop("PYTHONUTF8", None)
    return subprocess.run(
        [sys.executable, str(ENGINE), *args],
        capture_output=True,
        env=env,
        cwd=str(REPO),
        timeout=300,
    )


def run_python(code: str) -> subprocess.CompletedProcess:
    """Run an inline snippet (same scrubbed env as run_engine)."""
    env = os.environ.copy()
    env.pop("PYTHONIOENCODING", None)
    env.pop("PYTHONUTF8", None)
    return subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        env=env,
        cwd=str(REPO),
        timeout=300,
    )


# Preamble for exit-code tests: import the engine and let the snippet replace
# cmd_list with a raising stub before invoking main(). No data is touched.
ENGINE_STUB_PREAMBLE = (
    "import errno, sys\n"
    f"sys.path.insert(0, {str(REPO)!r})\n"
    "import cowork_export as ce\n"
)


def decode_utf8(data: bytes, label: str) -> str | None:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as e:
        check(False, f"{label} decodes as UTF-8 ({e})")
        return None


def parse_json(text: str, label: str):
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        check(False, f"{label} parses as JSON ({e}); head: {text[:200]!r}")
        return None


def test_list_json() -> list:
    print("[1] list --json")
    proc = run_engine("list", "--json")
    check(proc.returncode == 0,
          f"exit code 0 (got {proc.returncode}; stderr: {proc.stderr[:300]!r})")
    out = decode_utf8(proc.stdout, "stdout")
    if out is None:
        return []
    tasks = parse_json(out, "entire stdout")
    if tasks is None:
        return []
    if not check(isinstance(tasks, list), "stdout is a single JSON array"):
        return []
    check(len(tasks) >= 1, f"at least one real task found (got {len(tasks)})")
    bad = []
    for i, t in enumerate(tasks):
        if not isinstance(t, dict):
            bad.append(f"#{i} not an object")
            continue
        missing = LIST_KEYS - set(t)
        if missing:
            bad.append(f"#{i} missing keys: {sorted(missing)}")
    check(not bad, f"every element has all {len(LIST_KEYS)} keys"
          + (f" — {bad[:3]}" if bad else ""))
    if tasks and isinstance(tasks[0], dict) and not bad:
        t = tasks[0]
        check(isinstance(t["task_id"], str) and t["task_id"], "task_id is a non-empty string")
        check(t["source"] in ("cowork", "code"), f"source is cowork|code (got {t['source']!r})")
        check(isinstance(t["created_at_ms"], int), "created_at_ms is an int")
        check(isinstance(t["last_activity_ms"], int), "last_activity_ms is an int")
        check(isinstance(t["archived"], bool), "archived is a bool")
        check(isinstance(t["has_transcript"], bool), "has_transcript is a bool")
        for key in ("transcript_path", "task_dir", "task_meta_file"):
            check(t[key] is None or isinstance(t[key], str), f"{key} is str|null")
    return tasks if isinstance(tasks, list) else []


def test_list_json_source_code() -> None:
    print("[2] list --json --source code")
    proc = run_engine("list", "--json", "--source", "code")
    check(proc.returncode == 0,
          f"exit code 0 (got {proc.returncode}; stderr: {proc.stderr[:300]!r})")
    out = decode_utf8(proc.stdout, "stdout")
    if out is None:
        return
    data = parse_json(out, "entire stdout")
    check(isinstance(data, list), "stdout is a JSON array (empty array is fine)")


def test_export_progress_json(tasks: list) -> None:
    print("[3] export <task> --progress-json --no-files --formats md")
    candidates = [t for t in tasks
                  if isinstance(t, dict) and t.get("has_transcript") and t.get("task_id")]
    if not check(bool(candidates), "a task with a transcript exists to export"):
        return
    tid = candidates[0]["task_id"]
    with tempfile.TemporaryDirectory(prefix="cowork-selftest-") as tmp:
        proc = run_engine("export", tid, "--progress-json", "--no-files",
                          "-o", tmp, "--formats", "md")
        check(proc.returncode == 0,
              f"exit code 0 (got {proc.returncode}; stderr: {proc.stderr[:300]!r})")
        out = decode_utf8(proc.stdout, "stdout")
        if out is None:
            return
        lines = [ln for ln in out.splitlines() if ln.strip()]
        if not check(bool(lines), "stdout has at least one NDJSON line"):
            return
        events = []
        all_json = True
        for ln in lines:
            obj = parse_json(ln, "stdout line")
            if not isinstance(obj, dict) or "event" not in obj:
                all_json = False
                continue
            events.append(obj)
        check(all_json and len(events) == len(lines),
              'every stdout line is a JSON object with an "event" key')
        names = [e["event"] for e in events]
        check("task_start" in names, f'a "task_start" event was emitted ({names})')
        check("task_done" in names, f'a "task_done" event was emitted ({names})')
        check(bool(events) and events[-1]["event"] == "done",
              f'last event is "done" (got {names[-1] if names else "none"})')
        start = next((e for e in events if e["event"] == "task_start"), None)
        if start is not None:
            check(start.get("task_id") == tid, "task_start.task_id matches the selector")
            check(isinstance(start.get("index"), int) and isinstance(start.get("total"), int),
                  "task_start has int index/total")
        if events and events[-1]["event"] == "done":
            done = events[-1]
            check(done.get("exported") == 1 and done.get("total") == 1,
                  f"done reports exported=1 total=1 (got {done})")
        bundle = Path(tmp) / tid
        check((bundle / "session.md").exists(), "bundle contains session.md")
        check((bundle / "manifest.json").exists(), "bundle contains manifest.json")


def test_cp1252_pipe() -> None:
    print("[4] piped output with PYTHONIOENCODING unset (cp1252 console)")
    proc = run_engine("list", "--json")
    check(proc.returncode == 0,
          f"exit code 0 (got {proc.returncode}; stderr: {proc.stderr[:300]!r})")
    check(decode_utf8(proc.stdout, "stdout") is not None,
          "stdout is valid UTF-8 despite locale console")
    check(b"Traceback" not in proc.stderr, "no traceback on stderr")


def test_crash_exit_code() -> None:
    print("[5] unexpected exception exits 4 with a traceback")
    proc = run_python(ENGINE_STUB_PREAMBLE + (
        "def boom(args):\n"
        "    raise RuntimeError('selftest-crash')\n"
        "ce.cmd_list = boom\n"
        "sys.exit(ce.main(['list']))\n"
    ))
    check(proc.returncode == 4,
          f"exit code 4 (got {proc.returncode}; stderr: {proc.stderr[:300]!r})")
    check(b"Traceback" in proc.stderr and b"selftest-crash" in proc.stderr,
          "traceback with the crash message is on stderr")


def test_einval_scoping() -> None:
    print("[6] OSError EINVAL scoping (filesystem vs broken stream)")
    proc = run_python(ENGINE_STUB_PREAMBLE + (
        "def bad_path(args):\n"
        "    raise OSError(errno.EINVAL, 'Invalid argument', '/bad/selftest/path')\n"
        "ce.cmd_list = bad_path\n"
        "sys.exit(ce.main(['list']))\n"
    ))
    check(proc.returncode == 4,
          f"filesystem EINVAL exits 4, not a silent 1 (got {proc.returncode})")
    check(b"Traceback" in proc.stderr and b"/bad/selftest/path" in proc.stderr,
          "filesystem EINVAL prints a visible traceback on stderr")
    proc = run_python(ENGINE_STUB_PREAMBLE + (
        "def pipe_gone(args):\n"
        "    raise OSError(errno.EINVAL, 'Invalid argument')\n"
        "ce.cmd_list = pipe_gone\n"
        "sys.exit(ce.main(['list']))\n"
    ))
    check(proc.returncode == 1,
          f"stream-write EINVAL (no filename) exits 1 quietly (got {proc.returncode})")
    check(b"Traceback" not in proc.stderr,
          "stream-write EINVAL prints no traceback")


def main() -> int:
    print(f"engine: {ENGINE}")
    print(f"python: {sys.executable}")
    tasks = test_list_json()
    test_list_json_source_code()
    test_export_progress_json(tasks)
    test_cp1252_pipe()
    test_crash_exit_code()
    test_einval_scoping()
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
