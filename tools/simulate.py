"""Replay a fake race against the backend (Apps Script or mock) and check it.

    uv run tools/simulate.py --url http://localhost:8765/api --pin test
    uv run tools/simulate.py --url https://script.google.com/macros/s/.../exec --pin 1234 --until 11:00

Sends events from several "phones" in parallel, re-sends a batch to check
de-duplication, then reads the data back and compares loop counts.
"""

import argparse
import json
import random
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

EDT = timezone(timedelta(hours=-4))
START = datetime(2026, 10, 24, 9, 0, tzinfo=EDT)
LAST_START = datetime(2026, 10, 24, 14, 59, 59, tzinfo=EDT)
END = datetime(2026, 10, 24, 16, 0, tzinfo=EDT)


def ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def fake_race(bibs: list[int], rng: random.Random) -> tuple[list[dict], dict[int, int]]:
    """Return events and the expected number of valid loops per bib."""
    events, expected = [], {}
    n = 0

    def ev(bib, typ, dt):
        nonlocal n
        n += 1
        return {"id": f"sim{n:05d}{rng.randrange(1000):03d}", "bib": bib, "type": typ, "ts": ms(dt), "source": "sim"}

    for bib in bibs:
        pace = rng.uniform(14, 30)  # minutes per loop
        quits = rng.random() < 0.1
        stop_at = START + timedelta(hours=rng.uniform(1, 5)) if quits else END
        dep, loops = START, 0
        while True:
            arr = dep + timedelta(minutes=pace * rng.uniform(0.92, 1.15))
            if arr > END or arr > stop_at + timedelta(hours=1):
                break
            events.append(ev(bib, "A", arr))
            if dep <= LAST_START:
                loops += 1
            if arr > stop_at:
                events.append(ev(bib, "DNF", arr + timedelta(minutes=2)))
                break
            dep = arr + timedelta(minutes=rng.choice([0.2, 0.5, 1, 2, 5, 10]))
            if dep > LAST_START:
                break
            events.append(ev(bib, "D", dep))
        expected[bib] = loops
    return events, expected


def post(url: str, pin: str, events: list[dict]) -> dict:
    body = json.dumps({"action": "events", "pin": pin, "events": events}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "text/plain;charset=utf-8"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def get(url: str) -> dict:
    with urllib.request.urlopen(f"{url}?action=data&t={time.time()}", timeout=60) as r:
        return json.loads(r.read())


def count_loops(events: list[dict]) -> dict[int, int]:
    """Independent re-implementation of the loop rule, for cross-checking."""
    voided = {e["ref"] for e in events if e["type"] == "VOID"}
    by_bib: dict[int, list[dict]] = {}
    for e in events:
        if e["type"] in ("D", "A") and e["id"] not in voided and not e.get("void"):
            by_bib.setdefault(int(e["bib"]), []).append(e)
    out = {}
    for bib, evs in by_bib.items():
        evs.sort(key=lambda e: e["ts"])
        open_ts, loops = ms(START), 0
        for e in evs:
            if e["type"] == "D":
                open_ts = e["ts"]
            elif open_ts is not None:
                if open_ts <= ms(LAST_START) and e["ts"] <= ms(END):
                    loops += 1
                open_ts = None
        out[bib] = loops
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--pin", required=True)
    ap.add_argument("--runners", type=int, default=0, help="0 = all participants from the backend")
    ap.add_argument("--phones", type=int, default=3, help="parallel senders")
    ap.add_argument("--batch", type=int, default=5, help="events per POST")
    ap.add_argument("--until", default="16:00", help="only send events up to this clock time")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    data = get(args.url)
    bibs = [p["bib"] for p in data["participants"]] or list(range(1, 151))
    if args.runners:
        bibs = bibs[: args.runners]
    before = {e["id"] for e in data["events"]}

    events, _ = fake_race(bibs, rng)
    h, m = map(int, args.until.split(":"))
    cutoff = ms(START.replace(hour=h, minute=m))
    events = sorted((e for e in events if e["ts"] <= cutoff), key=lambda e: e["ts"])
    batches = [events[i : i + args.batch] for i in range(0, len(events), args.batch)]
    print(f"{len(bibs)} runners, {len(events)} events, {len(batches)} POSTs from {args.phones} phones")

    t0 = time.time()
    latencies = []

    def send(batch):
        t = time.time()
        res = post(args.url, args.pin, batch)
        latencies.append(time.time() - t)
        if res.get("error"):
            raise RuntimeError(res["error"])
        return len(res["accepted"])

    with ThreadPoolExecutor(args.phones) as pool:
        accepted = sum(pool.map(send, batches))
    took = time.time() - t0
    latencies.sort()
    print(f"accepted {accepted}/{len(events)} in {took:.1f}s; "
          f"POST latency median {latencies[len(latencies)//2]:.2f}s, max {latencies[-1]:.2f}s")

    dup = post(args.url, args.pin, batches[0])
    print(f"re-sent first batch: {len(dup['accepted'])} accepted, {len(dup['duplicates'])} duplicates (expect 0 / {len(batches[0])})")

    time.sleep(1)
    after = get(args.url)
    new = [e for e in after["events"] if e["id"] not in before]
    print(f"read back {len(new)} new events (expect {len(events)})")
    want = count_loops(events)
    got = count_loops(new)
    diffs = {b: (want.get(b, 0), got.get(b, 0)) for b in set(want) | set(got) if want.get(b, 0) != got.get(b, 0)}
    print("loop counts match" if not diffs else f"MISMATCH (bib: expected, got): {diffs}")
    ok = accepted == len(events) and len(new) == len(events) and not diffs and not dup["accepted"]
    print("OK" if ok else "PROBLEM")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
