"""Audit the live data: missing loops, odd loops, suspicious entries, and how to fix them.

    uv run tools/check_gaps.py              # problems for every runner
    uv run tools/check_gaps.py --all        # also harmless things (double taps...)
    uv run tools/check_gaps.py --bib 65     # one runner: timeline, loops, problems

Entries are paired like the app does (docs/js/race.js): virtual departure at
09:00, D opens a loop, A closes it. The app never guesses a missing entry, so
a missing D or A loses the loop until someone adds it. Severity:
    !!  the loop count is probably wrong (missing D/A, merged loops...)
    !   worth a look (loop too fast/slow for this runner, odd order...)
    .   harmless, shown with --all (double taps, late entries...)
Each problem comes with a fix. Times marked ≈ are estimated from the runner's
own pace (summit splits when there is one): use the paper time if you have it.
"""

import argparse
import json
import re
import statistics
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
TZ = ZoneInfo("America/Toronto")


def at(h: int, m: int, s: int = 0) -> float:
    return datetime(2026, 10, 24, h, m, s, tzinfo=TZ).timestamp() * 1000


START, LAST_START, END = at(9, 0), at(14, 59, 59), at(16, 0)
SEC, MIN = 1000, 60_000
MIN_LAP = 10 * MIN  # same threshold as the app
TAP_S = 60  # same-type repeats closer than this are double taps
SWAP_S = 10  # D just before A for the same bib: the runner turned straight around
TEST_BIBS = {999}

HOW = """Comment corriger :
  ajouter    /chrono → cocher « saisie manuelle » → DÉPART/ARRIVÉE, heure, dossard
  modifier   Sheet, onglet events : colonne B = dossard, D = heure (ex. 10:42:15)
  annuler    Sheet, onglet events : cocher la colonne I (void), ne pas supprimer la ligne"""


def endpoint() -> str:
    # same URL as the apps, so there is one place to change it
    src = (ROOT / "docs/js/api.js").read_text()
    return re.search(r"DEFAULT_ENDPOINT = '([^']+)'", src).group(1)


def load(path: str | None) -> dict:
    if path:
        return json.loads(Path(path).read_text())
    with urllib.request.urlopen(endpoint(), timeout=30) as r:
        return json.load(r)


def clock(ms: float) -> str:
    return datetime.fromtimestamp(ms / 1000, TZ).strftime("%H:%M:%S")


def dur(ms: float) -> str:
    s = round(ms / 1000)
    return f"{s // 3600}:{s // 60 % 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(x, hi)) if lo <= hi else (lo + hi) / 2


def active(events: list[dict]) -> list[dict]:
    voided = {e.get("ref") for e in events if e["type"] == "VOID"}
    return [e for e in events if e["type"] != "VOID" and not e.get("void") and e["id"] not in voided]


def pair(evs: list[dict], now: float) -> tuple[list[dict], list[dict], dict | None, bool]:
    """Pair one runner's sorted events like the app. Returns laps, raw findings,
    the open loop (if on course) and whether a DNF was entered."""
    laps, found = [], []
    add = lambda kind, **kw: found.append({"kind": kind, **kw})
    open_ = {"ts": START, "virtual": True, "mids": []}
    prev, dnf, rest_mid = None, None, None

    for i, e in enumerate(evs):
        t, ts = e["type"], e["ts"]
        nxt = evs[i + 1] if i + 1 < len(evs) else None
        if dnf and t != "DNF":
            add("after_dnf", t=t, ts=ts, dnf=dnf)
        if ts > now + 2 * MIN:
            add("future", t=t, ts=ts)

        if t == "DNF":
            dnf = dnf or ts
        elif t == "D":
            real_open = open_ and not open_.get("virtual")
            if real_open and nxt and nxt["type"] == "A" and nxt["ts"] - ts <= SWAP_S * SEC:
                add("swap", d=ts, a=nxt["ts"])
            elif real_open and ts - open_["ts"] <= TAP_S * SEC:
                add("tap", t="D", a=open_["ts"], b=ts)
            elif real_open:
                add("missing_a", d1=open_["ts"], d2=ts, mids=open_["mids"])
            elif open_ and ts - START > 5 * MIN:
                add("first_d", ts=ts, mids=open_["mids"])
            elif rest_mid:
                add("missing_d_open", a=prev["ts"], mid=rest_mid, d=ts)
            if ts > LAST_START:
                add("late_d", ts=ts)
            open_, rest_mid = {"ts": ts, "mids": []}, None
        elif t == "M":
            if open_:
                open_["mids"].append(ts)
            else:
                rest_mid = rest_mid or ts
        elif t == "A":
            if not open_:
                if prev and prev["type"] == "A" and ts - prev["ts"] <= TAP_S * SEC:
                    add("tap", t="A", a=prev["ts"], b=ts)
                else:
                    add("missing_d", a1=prev["ts"], a2=ts, mid=rest_mid)
                prev, rest_mid = e, None
                continue
            laps.append({"dep": open_["ts"], "arr": ts, "ms": ts - open_["ts"], "mids": open_["mids"],
                         "valid": open_["ts"] <= LAST_START and ts <= END})
            if ts > END:
                add("late_a", ts=ts)
            open_ = None
        if t in ("D", "A"):
            prev = e

    if rest_mid:
        add("rest_mid", a=prev["ts"], mid=rest_mid)
    return laps, found, open_, bool(dnf)


def pace(laps: list[dict]) -> dict:
    """This runner's typical lap, D→summit and summit→A, with fallbacks."""
    ok = [l for l in laps if l["valid"] and l["ms"] >= MIN_LAP and len(l["mids"]) <= 1]
    lap = statistics.median(l["ms"] for l in ok) if ok else 25 * MIN
    split = [l for l in ok if len(l["mids"]) == 1]
    up = statistics.median(l["mids"][0] - l["dep"] for l in split) if len(split) >= 2 else 0.58 * lap
    return {"lap": lap, "up": up, "down": lap - up, "med": lap if len(ok) >= 3 else None}


def audit(evs: list[dict], now: float) -> tuple[list[dict], list[tuple[str, str, str]]]:
    """Laps and (severity, problem, fix) for one runner."""
    laps, found, open_, dnf = pair(evs, now)
    p = pace(laps)
    bib = int(evs[0]["bib"]) if evs else 0
    out = []
    add = lambda sev, msg, fix="": out.append((sev, msg, fix))

    def est_arrival(dep: float, mids: list[float], before: float) -> float:
        guess = mids[0] + p["down"] if mids else dep + p["lap"]
        return clamp(guess, (mids[-1] if mids else dep) + 2 * MIN, before - 5 * SEC)

    # a loop can't fit between two entries this close: one is someone else's
    too_close = lambda a, b: b - a < max(MIN_LAP, 0.6 * p["lap"])

    for f in found:
        k = f["kind"]
        if k == "swap":
            add("!!", f"D {clock(f['d'])} saisi juste avant A {clock(f['a'])} : la boucle est perdue",
                f"modifier l'heure du D {clock(f['d'])} → {clock(f['a'] + SEC)}")
        elif k == "tap":
            add(".", f"double tap {f['t']} {clock(f['a'])} / {clock(f['b'])}",
                f"rien à faire (optionnel : annuler celui de {clock(f['b'])})")
        elif k in ("missing_a", "missing_d") and too_close(*((f["d1"], f["d2"]) if k == "missing_a" else (f["a1"], f["a2"]))):
            t, a, b = ("D", f["d1"], f["d2"]) if k == "missing_a" else ("A", f["a1"], f["a2"])
            add("!!", f"deux {t} à {clock(a)} et {clock(b)} : trop proches pour une boucle ({dur(b - a)})",
                f"vérifier sur papier : un des deux {t} est sûrement celui d'un autre dossard → modifier le dossard ou annuler")
        elif k == "missing_a":
            a = est_arrival(f["d1"], f["mids"], f["d2"])
            seen = f", sommet à {clock(f['mids'][0])}" if f["mids"] else ""
            add("!!", f"arrivée manquante entre D {clock(f['d1'])} et D {clock(f['d2'])}{seen}",
                f"ajouter ARRIVÉE {bib} à ≈{clock(a)}")
        elif k == "first_d":
            a = est_arrival(START, f["mids"], f["ts"])
            if f["mids"] or f["ts"] - START < 1.6 * p["lap"]:
                add("!!", f"arrivée de la 1re boucle manquante (premier D à {clock(f['ts'])})",
                    f"ajouter ARRIVÉE {bib} à ≈{clock(a)}")
            else:
                add("!", f"premier D à {clock(f['ts'])} : départ tardif, ou 1re boucle manquante ?",
                    f"si parti à 09:00 : ajouter ARRIVÉE {bib} à ≈{clock(a)}, sinon rien à faire")
        elif k in ("missing_d", "missing_d_open"):
            a1, mid = (f["a1"], f["mid"]) if k == "missing_d" else (f["a"], f["mid"])
            after = f["a2"] if k == "missing_d" else f["d"]
            hi = (mid if mid else after) - 2 * MIN
            d = clamp(mid - p["up"] if mid else after - p["lap"], a1 + 5 * SEC, hi)
            seen = f", sommet à {clock(mid)}" if mid else ""
            if k == "missing_d":
                add("!!", f"départ manquant entre A {clock(a1)} et A {clock(after)}{seen}",
                    f"ajouter DÉPART {bib} à ≈{clock(d)}")
            else:
                add("!!", f"sommet à {clock(mid)} pendant le repos, avant le D {clock(after)} : D et A manquants",
                    f"ajouter DÉPART {bib} à ≈{clock(d)} et ARRIVÉE {bib} à ≈{clock(est_arrival(d, [mid], after))}")
        elif k == "rest_mid":
            d = clamp(f["mid"] - p["up"], f["a"] + 5 * SEC, f["mid"] - 2 * MIN)
            add("!!", f"sommet à {clock(f['mid'])} pendant le repos (depuis A {clock(f['a'])}) : départ manquant",
                f"ajouter DÉPART {bib} à ≈{clock(d)}")
        elif k == "after_dnf":
            add("!", f"{f['t']} à {clock(f['ts'])} après l'abandon ({clock(f['dnf'])})",
                "si l'abandon est une erreur : annuler le DNF, sinon annuler cette saisie")
        elif k == "future":
            add("!", f"{f['t']} à {clock(f['ts'])} dans le futur (heure du téléphone ?)", "modifier l'heure")
        elif k == "late_d":
            add(".", f"D à {clock(f['ts'])} après 14:59:59 : la boucle ne comptera pas")
        elif k == "late_a":
            add(".", f"A à {clock(f['ts'])} après 16:00 : la boucle ne compte pas")

    # loop times against this runner's own pace
    med = p["med"]
    for n, l in enumerate(laps, 1):
        what = f"boucle {n} ({clock(l['dep'])} → {clock(l['arr'])}) en {dur(l['ms'])}"
        if len(l["mids"]) >= 2 and too_close(l["mids"][0], l["mids"][-1]):
            add(".", f"{what} : double tap au sommet {clock(l['mids'][0])} / {clock(l['mids'][-1])}", "rien à faire")
        elif len(l["mids"]) >= 2:
            a = clamp(l["mids"][0] + p["down"], l["mids"][0] + 2 * MIN, l["mids"][1] - 4 * MIN)
            add("!!", f"{what} avec {len(l['mids'])} passages au sommet : deux boucles fusionnées",
                f"ajouter ARRIVÉE {bib} à ≈{clock(a)} puis DÉPART {bib} à ≈{clock(a + 30 * SEC)}")
        elif l["ms"] < MIN_LAP:
            add("!!", f"{what} : moins de 10 min",
                "vérifier sur papier : ce D ou cet A est sûrement celui d'un autre dossard → modifier le dossard ou annuler")
        elif med and l["ms"] < 0.7 * med:
            add("!", f"{what} : trop rapide pour ce coureur (médiane {dur(med)})",
                "vérifier sur papier : D trop tard ou A trop tôt (autre dossard ?) → modifier l'heure ou le dossard")
        elif med and l["ms"] > 1.8 * med:
            add("!", f"{what} : très lente pour ce coureur (médiane {dur(med)})",
                "vérifier sur papier : un A + D manquent peut-être au milieu, sinon rien à faire")
        elif med and l["ms"] > 1.4 * med:
            add(".", f"{what} : lente pour ce coureur (médiane {dur(med)})")
        if l["mids"] and not l["dep"] <= l["mids"][0] <= l["arr"]:
            add("!", f"{what} : sommet hors de la boucle", "vérifier l'heure du sommet")

    # still on course for too long
    if open_ and not dnf and now < END and now - open_["ts"] > max(1.8 * p["lap"], 40 * MIN):
        since = "le départ de 09:00" if open_.get("virtual") else f"D {clock(open_['ts'])}"
        if open_["mids"]:
            a = est_arrival(open_["ts"], open_["mids"], now)
            add("!!", f"en course depuis {dur(now - open_['ts'])} ({since}), sommet à {clock(open_['mids'][-1])}",
                f"ajouter ARRIVÉE {bib} à ≈{clock(a)}, ou DNF en cas d'abandon")
        else:
            add("!", f"en course depuis {dur(now - open_['ts'])} ({since})",
                f"ajouter l'ARRIVÉE {bib} (heure papier), ou DNF en cas d'abandon")

    return laps, out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bib", type=int, help="show one runner in detail")
    ap.add_argument("--all", action="store_true", help="also show harmless issues")
    ap.add_argument("--file", help="read a saved JSON instead of fetching")
    args = ap.parse_args()

    data = load(args.file)
    now = data["serverTime"]
    names = {p["bib"]: p["name"] for p in data["participants"]}
    by_bib: dict[int, list[dict]] = {}
    for e in sorted(active(data["events"]), key=lambda e: e["ts"]):
        if e.get("bib") is not None:
            by_bib.setdefault(int(e["bib"]), []).append(e)
    print(f"Données à {clock(now)}\n")

    if args.bib is not None:
        voided = {e.get("ref") for e in data["events"] if e["type"] == "VOID"}
        raw = sorted((e for e in data["events"] if e.get("bib") == args.bib and e["type"] != "VOID"), key=lambda e: e["ts"])
        laps, issues = audit(by_bib.get(args.bib, []), now)
        print(f"{args.bib} {names.get(args.bib, 'dossard inconnu')}  ·  {sum(l['valid'] for l in laps)} boucle(s) comptée(s)\n")
        for e in raw:
            off = "  (annulé)" if e.get("void") or e["id"] in voided else ""
            print(f"  {clock(e['ts'])}  {e['type']:<3} {e.get('source', '')}{off}")
        print()
        for n, l in enumerate(laps, 1):
            print(f"  boucle {n:>2}  {clock(l['dep'])} → {clock(l['arr'])}  {dur(l['ms']):>7}{'' if l['valid'] else '  (ne compte pas)'}")
        print()
        for sev, msg, fix in issues:
            print(f"  {sev:<2} {msg}" + (f"\n       → {fix}" if fix else ""))
        if not issues:
            print("  rien à signaler")
        print(f"\n{HOW}")
        return

    counts = {"!!": 0, "!": 0, ".": 0}
    for bib, evs in sorted(by_bib.items()):
        if bib in TEST_BIBS:
            continue
        if bib not in names:
            issues = [("!!", f"dossard inconnu : {len(evs)} saisie(s), de {clock(evs[0]['ts'])} à {clock(evs[-1]['ts'])}",
                       "trouver le bon dossard (chiffres proches ou inversés) → modifier la colonne B")]
        else:
            _, issues = audit(evs, now)
        shown = [i for i in issues if args.all or i[0] != "."]
        for sev, msg, fix in sorted(shown, key=lambda x: len(x[0]), reverse=True):
            counts[sev] += 1
            print(f"{sev:<2} {bib:>4}  {names.get(bib, '?')[:24]:<24} {msg}")
            if fix:
                print(f"{'':<34}→ {fix}")

    print(f"\n{counts['!!']} à corriger (!!), {counts['!']} à vérifier (!)" + (f", {counts['.']} sans gravité (.)" if args.all else ""))
    print(f"\n{HOW}")


if __name__ == "__main__":
    main()
