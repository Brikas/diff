"""Screenshots every eval case in the real app, in Split and in Unified layout.

Creates each case as a diff on a running server, opens it in headless Chrome, and saves
full-page PNGs to <out>/<case id>/{split,unified}.png.

Usage:
    python eval/render.py -o eval/out/r1 -b http://localhost:8799 eval/cases-a.json eval/cases-b.json
    python eval/render.py -o eval/out/r2 -i a07,b12 eval/cases-*.json   # only some cases
"""
import argparse
import json
import sys
import urllib.request
from pathlib import Path

from patchright.sync_api import sync_playwright

LAYOUTS = ("split", "unified")
SETTLE_MS = 700  # the app recomputes counts and moves 150 ms after a change; leave room for both views


def create_diff(base: str, before: str, after: str) -> str:
    """Creates a diff through the public API and returns its edit token."""
    req = urllib.request.Request(
        f"{base}/api/diffs",
        data=json.dumps({"left": before, "right": after}).encode(),
        headers={"content-type": "application/json", "x-diff": "1"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)["edit"]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cases", nargs="+", help="case files (JSON arrays of {id, before, after})")
    ap.add_argument("-o", "--out", required=True, help="output folder, one subfolder per case")
    ap.add_argument("-b", "--base", default="http://localhost:8799", help="app URL, default %(default)s")
    ap.add_argument("-i", "--ids", help="comma-separated case ids to render, e.g. a07,b12")
    ap.add_argument("-w", "--width", type=int, default=1400, help="viewport width, default %(default)s")
    args = ap.parse_args()

    cases = [c for f in args.cases for c in json.loads(Path(f).read_text())]
    if args.ids:
        wanted = set(args.ids.split(","))
        cases = [c for c in cases if c["id"] in wanted]
    out = Path(args.out)

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        pages = {}
        for layout in LAYOUTS:
            # Tall viewport: the editor only draws lines near the screen, and long cases must render whole.
            ctx = browser.new_context(viewport={"width": args.width, "height": 3000}, color_scheme="light")
            ctx.add_init_script(f"localStorage.setItem('layout', '{layout}'); localStorage.setItem('gran', 'smart');")
            pages[layout] = ctx.new_page()
        for i, c in enumerate(cases, 1):
            print(f"[{i}/{len(cases)}] {c['id']}", flush=True)
            token = create_diff(args.base, c["before"], c["after"])
            folder = out / c["id"]
            folder.mkdir(parents=True, exist_ok=True)
            for layout, page in pages.items():
                page.goto(f"{args.base}/{token}")
                page.wait_for_selector(".cm-editor")
                page.wait_for_timeout(SETTLE_MS)
                # Crop to the text: the editor pads itself to the window height, which is mostly empty here.
                bottom = page.evaluate(
                    "Math.max(...[...document.querySelectorAll('.cm-content > *')].map(e => e.getBoundingClientRect().bottom))"
                )
                height = min(int(bottom) + 40, page.viewport_size["height"])
                page.screenshot(path=str(folder / f"{layout}.png"), clip={"x": 0, "y": 0, "width": args.width, "height": height})
        browser.close()
    print(f"rendered {len(cases)} cases into {out}", file=sys.stderr)


if __name__ == "__main__":
    main()
