"""Local stand-in for the Apps Script backend, for testing without Google.

Serves docs/ as static files and the same API as Code.gs at /api:
    uv run tools/mock_server.py
    open http://localhost:8765/saisie.html?api=/api   (PIN: test)
"""

import argparse
import json
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from participants import load_participants

ROOT = Path(__file__).resolve().parent.parent
TYPES = {"D", "A", "DNF", "VOID"}


class Store:
    def __init__(self, path: Path, participants: list[dict]):
        self.path = path
        self.participants = participants
        self.lock = threading.Lock()
        self.events = json.loads(path.read_text()) if path.exists() else []

    def add(self, events: list[dict]) -> dict:
        accepted, duplicates, rejected = [], [], []
        with self.lock:
            ids = {e["id"] for e in self.events}
            for ev in events:
                problem = validate(ev)
                if problem:
                    rejected.append({"id": ev.get("id"), "error": problem})
                elif ev["id"] in ids:
                    duplicates.append(ev["id"])
                else:
                    ids.add(ev["id"])
                    accepted.append(ev["id"])
                    row = {k: ev[k] for k in ("id", "bib", "type", "ts", "ref") if ev.get(k) is not None}
                    self.events.append(row)
            self.path.write_text(json.dumps(self.events))
        return {"ok": True, "accepted": accepted, "duplicates": duplicates, "rejected": rejected}


def validate(ev) -> str | None:
    if not isinstance(ev, dict) or not isinstance(ev.get("id"), str) or not ev["id"]:
        return "bad id"
    if ev.get("type") not in TYPES:
        return "bad type"
    if not isinstance(ev.get("ts"), (int, float)):
        return "bad ts"
    if ev["type"] == "VOID":
        return None if ev.get("ref") else "VOID needs ref"
    if not str(ev.get("bib", "")).isdigit():
        return "bad bib"
    return None


class Handler(SimpleHTTPRequestHandler):
    store: Store
    pin: str
    fail: bool = False

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if urlparse(self.path).path == "/api":
            if Handler.fail:
                return self._json({"error": "simulated outage"}, 503)
            s = self.store
            return self._json({"participants": s.participants, "events": s.events, "serverTime": time.time() * 1000})
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/toggle-outage":  # lets tests simulate going offline
            Handler.fail = not Handler.fail
            return self._json({"fail": Handler.fail})
        if path != "/api":
            return self._json({"error": "not found"}, 404)
        if Handler.fail:
            return self._json({"error": "simulated outage"}, 503)
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if body.get("pin") != self.pin:
            return self._json({"error": "NIP invalide"})
        return self._json(self.store.add(body.get("events", [])))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--pin", default="test")
    ap.add_argument("--data", type=Path, default=ROOT / "tools" / ".mock-events.json")
    ap.add_argument("--reset", action="store_true", help="start with no events")
    args = ap.parse_args()
    if args.reset and args.data.exists():
        args.data.unlink()
    Handler.store = Store(args.data, load_participants())
    Handler.pin = args.pin
    handler = partial(Handler, directory=str(ROOT / "docs"))
    print(f"http://localhost:{args.port}/saisie.html?api=/api  (PIN {args.pin})")
    print(f"http://localhost:{args.port}/index.html?api=/api")
    ThreadingHTTPServer(("", args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
