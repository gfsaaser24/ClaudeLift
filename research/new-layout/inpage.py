# Wrap a page-side JS file into a main-process script that runs it in the
# claude.ai page of Claude Desktop and returns the JSON result.
# Usage: python inpage.py page.js out.js
import json
import sys
from pathlib import Path

page = Path(sys.argv[1]).read_text(encoding="utf-8")
main = (
    "(async () => {\n"
    "  const req = typeof require === 'function' ? require : process.mainModule.require.bind(process.mainModule)\n"
    "  const { webContents } = req('electron')\n"
    "  const wc = webContents.getAllWebContents().find((w) => w.getType() === 'window' && w.getURL().startsWith('https://claude.ai'))\n"
    "  if (!wc) return 'claude.ai page not found'\n"
    f"  return JSON.stringify(await wc.executeJavaScript({json.dumps(page)}, true), null, 1)\n"
    "})()\n"
)
Path(sys.argv[2]).write_text(main, encoding="utf-8")
