"""Run tests/race.test.js in headless Chromium and print the results.

    uv run tools/run_js_tests.py
"""

import html
import json
import re
import shutil
import subprocess
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main() -> int:
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/tests/index.html"
    browser = shutil.which("chromium") or shutil.which("chromium-browser") or shutil.which("google-chrome")
    if not browser:
        print("No Chromium found")
        return 2
    dom = subprocess.run(
        [browser, "--headless", "--disable-gpu", "--virtual-time-budget=5000", "--dump-dom", url],
        capture_output=True, text=True, timeout=60,
    ).stdout
    server.shutdown()
    m = re.search(r'<pre id="out">(.*?)</pre>', dom, re.S)
    if not m or m.group(1) == "running":
        print("Tests did not run (module error?)\n", dom[:2000])
        return 1
    results = json.loads(html.unescape(m.group(1)))
    failed = [r for r in results if not r["ok"]]
    for r in results:
        print(("ok   " if r["ok"] else "FAIL ") + r["name"] + ("" if r["ok"] else f"\n     {r['err']}"))
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
