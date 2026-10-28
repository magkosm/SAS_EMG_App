#!/usr/bin/env python3
"""Build the static site for GitHub Pages into _site/.

GitHub Pages lets browsers cache files for ~10 minutes, so right after an update a browser could
mix old and new app modules (and break). This build stamps every file with a version:
  - css/app.css and js/app.js get ?v=<version> in index.html
  - an import map sends every other js/*.js import to ?v=<version> too
  - APP_VERSION in session.js gets the build version, so session.json records which build made it

Usage:  python3 tools/build_site.py [version]   (default: $GITHUB_SHA[:8] or a timestamp)
"""
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "_site"
COPY = ["index.html", "review.html", "css", "js"]


def main():
    version = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("GITHUB_SHA", "")[:8]) or time.strftime("%Y%m%d%H%M")
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    for name in COPY:
        src = ROOT / name
        (shutil.copytree if src.is_dir() else shutil.copy2)(src, OUT / name)

    modules = sorted(p.name for p in (OUT / "js").glob("*.js"))
    import_map = {"imports": {f"./js/{m}": f"./js/{m}?v={version}" for m in modules}}

    index = OUT / "index.html"
    html = index.read_text(encoding="utf-8")
    html = html.replace('href="css/app.css"', f'href="css/app.css?v={version}"', 1)
    entry = '<script type="module" src="js/app.js"></script>'
    if entry not in html:
        sys.exit("build_site: entry <script> for js/app.js not found in index.html")
    map_tag = '<script type="importmap">' + json.dumps(import_map, indent=1) + "</script>\n  "
    html = html.replace(entry, map_tag + entry.replace('js/app.js"', f'js/app.js?v={version}"'), 1)
    index.write_text(html, encoding="utf-8")

    session = OUT / "js" / "session.js"
    src = session.read_text(encoding="utf-8")
    src, n = re.subn(r"export const APP_VERSION = '([^']*)';", lambda m: f"export const APP_VERSION = '{m.group(1)}+{version}';", src)
    if n != 1:
        sys.exit("build_site: APP_VERSION not found in js/session.js")
    session.write_text(src, encoding="utf-8")

    (OUT / ".nojekyll").write_text("")
    print(f"Built {OUT.relative_to(ROOT)}/ (version {version}, {len(modules)} modules)")


if __name__ == "__main__":
    main()
