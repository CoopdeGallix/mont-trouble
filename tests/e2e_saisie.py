"""End-to-end test of the entry app against the mock server.

    uv run tests/e2e_saisie.py
"""

import json
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PORT = 8766
BASE = f"http://localhost:{PORT}"
DATA = ROOT / "tools" / ".e2e-events.json"


def server_events():
    with urllib.request.urlopen(f"{BASE}/api?action=data") as r:
        return json.loads(r.read())["events"]


def outage():
    urllib.request.urlopen(urllib.request.Request(f"{BASE}/toggle-outage", data=b"", method="POST"))


def main():
    DATA.unlink(missing_ok=True)
    srv = subprocess.Popen(
        [sys.executable, str(ROOT / "tools" / "mock_server.py"), "--port", str(PORT), "--data", str(DATA)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    time.sleep(1.5)
    shots = ROOT / "screenshots"
    shots.mkdir(exist_ok=True)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=shutil.which("chromium") or None)
            ctx = browser.new_context(viewport={"width": 390, "height": 844}, has_touch=True)
            page = ctx.new_page()
            page.on("dialog", lambda d: d.accept())
            page.goto(f"{BASE}/saisie.html?api=/api")

            def key(*keys):
                special = {"OK": "#keypad .ok", "del": "#keypad [data-k=del]"}
                for k in keys:
                    if k in special:
                        page.click(special[k])
                    else:
                        page.locator("#keypad button", has_text=k).first.click()

            # first launch asks for settings
            page.fill("#set-device", "Test arrivées")
            page.fill("#set-pin", "test")
            page.click("#settings button.primary")
            expect(page.locator("#sync")).to_have_text("✓ à jour")

            # arrival for bib 42, name shown while typing, time captured at first digit
            key("4", "2")
            expect(page.locator("#who")).to_contain_text("boucle")
            expect(page.locator("#captured")).to_contain_text(":")
            key("OK")
            expect(page.locator("#recent li").first).to_contain_text("42")
            page.wait_for_function("document.querySelector('#recent li .st').textContent.includes('✓')")
            assert len(server_events()) == 1, "first event reached server"
            print("ok   arrival synced")

            # second arrival without departure -> warning shown
            key("4", "2")
            expect(page.locator("#warns li")).to_contain_text(["Aucun départ ouvert (départ manquant ?)"])
            key("del", "del")
            print("ok   warning for arrival without departure")

            # summit mode: purple, shows the time in the runner line afterwards
            page.click(".modes button[data-m='M']")
            key("3", "3", "OK")
            expect(page.locator("#recent li").first.locator(".tag")).to_have_text("S")
            key("3", "3")
            expect(page.locator("#who")).to_contain_text("sommet")
            expect(page.locator("#warns li")).to_contain_text(["Déjà passé au sommet"])
            key("del", "del")
            page.click(".modes button[data-m='A']")
            print("ok   summit entry")

            # outage: entries queue up, survive a reload, then sync
            outage()
            key("1", "7", "OK")
            page.click(".modes button[data-m='D']")
            key("1", "7", "OK")
            expect(page.locator("#sync")).to_contain_text("2 en attente")
            page.reload()
            expect(page.locator("#sync")).to_contain_text("2 en attente")
            print("ok   queued while offline, kept after reload")
            outage()
            expect(page.locator("#sync")).to_have_text("✓ à jour", timeout=15000)
            assert len(server_events()) == 4
            print("ok   queue flushed when back online")

            # undo the last entry -> VOID event sent
            page.locator("#recent button[data-void]").first.click()
            expect(page.locator("#recent li.voided")).to_have_count(1)
            page.wait_for_function("document.querySelector('#sync').textContent.includes('à jour')")
            time.sleep(0.5)
            assert any(e["type"] == "VOID" for e in server_events())
            print("ok   undo sends VOID")

            # unknown bib asks for confirmation (auto-accepted here)
            key("9", "9", "9", "OK")
            expect(page.locator("#recent li").first).to_contain_text("999")
            print("ok   unknown bib recorded after confirm")

            # paper mode uses the typed time
            page.click(".modes button[data-m='A']")
            page.check("#paper-toggle")
            page.fill("#paper-time", "10:15:30")
            key("5", "OK")
            expect(page.locator("#recent li").first).to_contain_text("10:15:30")
            page.uncheck("#paper-toggle")
            print("ok   paper entry")

            # correct a wrong bib: original time kept, original voided
            page.locator("#recent button[data-fix]").first.click()
            expect(page.locator("#fix-time")).to_have_value("10:15:30")
            page.fill("#fix-bib", "6")
            page.click("#fix button.primary")
            top = page.locator("#recent li").first
            expect(top).to_contain_text("10:15:30")
            expect(top.locator("b")).to_have_text("6")
            expect(page.locator("#recent li.voided", has_text="Maude Lareau")).to_have_count(1)
            page.wait_for_function("document.querySelector('#sync').textContent.includes('à jour')")
            time.sleep(0.5)
            evs = server_events()
            fixed = [e for e in evs if e.get("bib") == 6 and e["type"] == "A"]
            assert len(fixed) == 1, fixed
            assert any(e["type"] == "VOID" and e["ref"] == next(x["id"] for x in evs if x.get("bib") == 5) for e in evs)
            print("ok   correction keeps time, voids original")

            # late registration: next bib prefilled, name shows up right away
            page.click("#open-signup")
            expect(page.locator("#su-bib")).to_have_value("84")
            page.fill("#su-name", "Nouvelle Coureuse")
            page.select_option("#su-sex", "F")
            page.click("#su-save")
            expect(page.locator("#signup")).not_to_be_visible()
            key("8", "4")
            expect(page.locator("#who")).to_contain_text("Nouvelle Coureuse")
            key("del", "del")
            print("ok   late registration")

            # bib already taken is refused and the dialog stays open
            page.click("#open-signup")
            page.fill("#su-bib", "1")
            page.fill("#su-name", "Doublon")
            page.click("#su-save")
            expect(page.locator("#su-msg")).to_contain_text("déjà pris")
            page.click("#su-cancel")
            print("ok   duplicate bib refused")

            # times entered before registering bib 999 attach to the new name
            page.click("#open-signup")
            page.fill("#su-bib", "999")
            page.fill("#su-name", "Inscrit Tardif")
            page.click("#su-save")
            expect(page.locator("#recent li", has_text="999")).to_contain_text("Inscrit Tardif")
            print("ok   earlier times attach to late registrant")
            page.screenshot(path=str(shots / "saisie-entries.png"), full_page=True)

            # the app shell loads with no network once cached by the service worker
            page.wait_for_function("navigator.serviceWorker.controller !== null", timeout=10000)
            ctx.set_offline(True)
            page.reload()
            expect(page.locator("#keypad")).to_be_visible()
            expect(page.locator("#recent li").first).to_contain_text("10:15:30")
            ctx.set_offline(False)
            print("ok   app opens offline")

            live = ctx.new_page()
            live.goto(f"{BASE}/index.html?api=/api")
            expect(live.locator("tr.runner").first).to_be_visible()
            live.locator("tr.runner", has_text="Croteau").click()
            live.screenshot(path=str(shots / "index-detail.png"), full_page=False)
            browser.close()
        print("\nall e2e checks passed")
    finally:
        srv.terminate()
        DATA.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
