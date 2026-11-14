#!/usr/bin/env python3
"""AH Browser: turns AHSnap's saved scans into the static site in site/.

    python tools/ahsnap.py              read new scans into site/data (same as "ingest")
    python tools/ahsnap.py serve        ingest, then preview the site at http://localhost:8788
    python tools/ahsnap.py publish      ingest, commit site/data, push it to GitHub and deploy to ah.clipp-y.com
    python tools/ahsnap.py deploy       deploy site/ as it is (after changing the site itself)
    python tools/ahsnap.py --wow "D:\\Games\\World of Warcraft\\_forever_" ...   another install

WoW writes addon data to disk only on /reload, logout or exit, so a scan shows up here after one
of those. The published data files are the history: each new scan is appended to them, so keep
the repo (or site/data) and nothing is lost. Standard library only.
"""

import argparse
import functools
import glob
import http.server
import json
import os
import re
import subprocess
import sys
import time
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
DATA = os.path.join(SITE, "data")
DEFAULT_WOW = r"C:\BNET\World of Warcraft\_forever_"
SHARDS = 64          # history files per realm (itemID % SHARDS)
MARKET_DEPTH = 0.15  # market price = the unit price this far into the stock (skips a few odd listings)
USUAL_DAYS = 14      # "usual" price = median market price over this many days before the scan


# ---------------------------------------------------------------- SavedVariables (Lua) reader

_TOKEN = re.compile(r"""
    \s+ | --[^\n]*
  | (?P<str>"(?:[^"\\]|\\.)*")
  | (?P<num>-?(?:0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][-+]?\d+)?|\.\d+))
  | (?P<name>[A-Za-z_][A-Za-z0-9_]*)
  | (?P<sym>[{}\[\]=,;])
""", re.X)
_ESC = re.compile(r'\\(\d{1,3}|.)', re.S)
_ESC_MAP = {"n": "\n", "r": "\r", "t": "\t", "\\": "\\", '"': '"', "'": "'", "\n": "\n"}


def _unescape(raw):
    if "\\" not in raw:
        return raw
    out = _ESC.sub(lambda m: chr(int(m.group(1))) if m.group(1).isdigit() else _ESC_MAP.get(m.group(1), m.group(1)), raw)
    try:  # decimal escapes are bytes of UTF-8 text
        return out.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return out


def _tokens(text):
    pos, n = 0, len(text)
    while pos < n:
        m = _TOKEN.match(text, pos)
        if not m:
            raise ValueError("unexpected character %r at offset %d" % (text[pos], pos))
        pos = m.end()
        kind = m.lastgroup
        if kind == "str":
            yield "str", _unescape(m.group(kind)[1:-1])
        elif kind == "num":
            s = m.group(kind)
            if s.lower().lstrip("-").startswith("0x"):
                yield "num", int(s, 16)
            else:
                f = float(s)
                yield "num", int(f) if f.is_integer() else f
        elif kind:
            yield kind, m.group(kind)
    yield "end", None


def parse_saved_variables(text):
    """{global name: value}. Lua tables become dicts, or lists when they are 1..n arrays."""
    toks = _tokens(text)
    cur = next(toks)

    def advance():
        nonlocal cur
        prev, cur = cur, next(toks)
        return prev

    def expect(sym):
        if cur != ("sym", sym):
            raise ValueError("expected %r, got %r" % (sym, cur[1]))
        advance()

    def value():
        kind, val = cur
        if kind in ("str", "num"):
            advance()
            return val
        if kind == "name" and val in ("true", "false", "nil"):
            advance()
            return None if val == "nil" else val == "true"
        if cur == ("sym", "{"):
            return table()
        raise ValueError("unexpected token %r" % (val,))

    def table():
        expect("{")
        out, auto = {}, 0
        while cur != ("sym", "}"):
            if cur == ("sym", "["):
                advance()
                key = value()
                expect("]")
                expect("=")
                out[key] = value()
            elif cur[0] == "name" and cur[1] not in ("true", "false", "nil"):
                key = advance()[1]
                expect("=")
                out[key] = value()
            else:
                auto += 1
                out[auto] = value()
            if cur in (("sym", ","), ("sym", ";")):
                advance()
        expect("}")
        n = len(out)
        if n and all(isinstance(k, int) for k in out) and min(out) == 1 and max(out) == n:
            return [out[i] for i in range(1, n + 1)]
        return [] if not n else out

    result = {}
    while cur[0] != "end":
        if cur[0] != "name":
            raise ValueError("expected a variable name, got %r" % (cur[1],))
        name = advance()[1]
        expect("=")
        result[name] = value()
    return result


# ---------------------------------------------------------------- files

def slug(realm_key):
    return re.sub(r"[^a-z0-9]+", "-", realm_key.lower()).strip("-")


def load(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, path)


def as_list(v):
    if isinstance(v, list):
        return v
    if isinstance(v, dict):
        return [v[k] for k in sorted(v)]
    return []


def num(s):
    try:
        return int(s)
    except (TypeError, ValueError):
        return None


ITEM_FIELDS = ["name", "quality", "ilvl", "req", "type", "subtype", "slot", "icon", "vendor", "stack", "classID", "subclassID"]


def parse_item(raw):
    parts = (raw or "").split("|")
    parts += [""] * (len(ITEM_FIELDS) - len(parts))
    out = dict(zip(ITEM_FIELDS, parts))
    for k in ("quality", "ilvl", "req", "icon", "vendor", "stack", "classID", "subclassID"):
        out[k] = num(out[k])
    return out


# ---------------------------------------------------------------- one scan -> per-item summaries

def parse_scan(scan):
    """{key: [[buyout, bid, stack, timeLeft, count], ...]} from the saved chunk strings."""
    items = {}
    for chunk in as_list(scan.get("d")):
        for entry in chunk.split(";"):
            if not entry:
                continue
            key, _, body = entry.partition(":")
            groups = []
            for g in body.split(","):
                f = [num(x) or 0 for x in g.split("/")]
                if len(f) == 5 and f[2] > 0 and f[4] > 0:
                    groups.append(f)
            if groups:
                items[key] = groups
    return items


def summarize(groups):
    """qty, auctions, cheapest unit buyout, market unit price, total buyout value."""
    qty = sum(g[2] * g[4] for g in groups)
    auctions = sum(g[4] for g in groups)
    priced = sorted((g[0] / g[2], g[2] * g[4]) for g in groups if g[0] > 0)
    value = sum(g[0] * g[4] for g in groups)
    if not priced:
        return qty, auctions, None, None, value
    units = sum(u for _, u in priced)
    target, acc, mkt = max(1, units * MARKET_DEPTH), 0, priced[0][0]
    for price, u in priced:
        acc += u
        if acc >= target:
            mkt = price
            break
    return qty, auctions, round(priced[0][0]), round(mkt), value


def sort_groups(groups):
    # cheapest per unit first; bid-only auctions last, by bid
    return sorted(groups, key=lambda g: (g[0] == 0, (g[0] or g[1]) / g[2], g[2]))


def median(xs):
    xs = sorted(xs)
    n = len(xs)
    if not n:
        return None
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


# ---------------------------------------------------------------- ingest

def find_saved(wow):
    return sorted(glob.glob(os.path.join(wow, "WTF", "Account", "*", "SavedVariables", "AHSnap.lua")))


def ingest(wow, quiet=False):
    files = find_saved(wow)
    if not files:
        print("No AHSnap data found under %s\\WTF yet. Scan in game, then /reload." % wow)
        return 0
    realms_index = {r["key"]: r for r in load(os.path.join(DATA, "realms.json"), [])}
    added = 0
    for path in files:
        with open(path, encoding="utf-8", errors="replace") as f:
            db = parse_saved_variables(f.read()).get("AHSnapDB") or {}
        meta = {k: parse_item(v) for k, v in (db.get("items") or {}).items()}
        for realm_key, scans in (db.get("scans") or {}).items():
            added += ingest_realm(realm_key, as_list(scans), meta, realms_index)
    save(os.path.join(DATA, "realms.json"), sorted(realms_index.values(), key=lambda r: r["label"]))
    if not quiet or added:
        print("%d new scan(s) added." % added if added else "No new scans. (Did you /reload after scanning?)")
    return added


def ingest_realm(realm_key, scans, meta, realms_index):
    d = os.path.join(DATA, slug(realm_key))
    scans_path = os.path.join(d, "scans.json")
    done = load(scans_path, [])
    have = {s[0] for s in done}
    new = sorted((s for s in scans if isinstance(s, dict) and s.get("t") and s["t"] not in have), key=lambda s: s["t"])
    if not new:
        return 0

    shards = {}

    def shard(key):
        i = (num(key.split(".")[0]) or 0) % SHARDS
        if i not in shards:
            shards[i] = load(os.path.join(d, "history", "%02d.json" % i), {})
        return shards[i]

    latest = None
    for scan in new:
        t = scan["t"]
        items = parse_scan(scan)
        value = 0
        for key, groups in items.items():
            qty, auctions, lo, mkt, v = summarize(groups)
            value += v
            shard(key).setdefault(key, []).append([t, lo, mkt, qty])
        done.append([t, scan.get("n") or sum(sum(g[4] for g in gs) for gs in items.values()), len(items), value])
        latest = (t, items)
        print("  %s  %s: %d items" % (realm_key, time.strftime("%Y-%m-%d %H:%M", time.localtime(t)), len(items)))

    done.sort()
    for i, h in shards.items():
        save(os.path.join(d, "history", "%02d.json" % i), h)
    save(scans_path, done)

    current = load(os.path.join(d, "latest.json"), {})
    t, items = latest
    if t >= current.get("t", 0):
        write_latest(d, realm_key, t, items, meta, shard)

    label = realm_key.rsplit("-", 1)
    realms_index[realm_key] = {
        "key": realm_key, "slug": slug(realm_key),
        "label": "%s (%s)" % (label[0], label[1]) if len(label) == 2 else realm_key,
        "t": done[-1][0], "scans": len(done), "auctions": done[-1][1], "items": done[-1][2],
    }
    return len(new)


def write_latest(d, realm_key, t, items, meta, shard):
    since = t - USUAL_DAYS * 86400
    rows = []
    auctions = 0
    for key, groups in items.items():
        qty, n, lo, mkt, _ = summarize(groups)
        auctions += n
        past = [h[2] for h in shard(key).get(key, []) if since <= h[0] < t and h[2]]
        usual = round(median(past)) if len(past) >= 2 else None
        m = meta.get(key) or parse_item("")
        rows.append([key, m["name"] or ("Item " + key), m["quality"], m["ilvl"], m["req"], m["type"], m["subtype"],
                     m["slot"], m["icon"], m["vendor"], qty, n, lo, mkt, usual, sort_groups(groups)])
    rows.sort(key=lambda r: r[1].lower())
    save(os.path.join(d, "latest.json"), {
        "realm": realm_key, "t": t, "auctions": auctions, "shards": SHARDS, "usualDays": USUAL_DAYS,
        "fields": ["key", "name", "quality", "ilvl", "req", "type", "subtype", "slot", "icon", "vendor",
                   "qty", "auctions", "min", "market", "usual", "listings"],
        "items": rows,
    })


# ---------------------------------------------------------------- serve and publish

class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def serve(port):
    url = "http://localhost:%d" % port
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=SITE))
    print("AH Browser at %s  (Ctrl+C to stop)" % url)
    webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


def git(*args, check=True):
    return subprocess.run(["git", *args], cwd=ROOT, check=check, capture_output=True, text=True)


def deploy():
    print("Deploying to Cloudflare...")
    r = subprocess.run("npx --yes wrangler@4.81.0 deploy", cwd=ROOT, shell=True, capture_output=True, text=True)
    if r.returncode:
        sys.exit("wrangler deploy failed:\n" + r.stdout[-2000:] + r.stderr[-2000:])
    print("Live at https://ah.clipp-y.com")


def publish():
    if not os.path.isdir(os.path.join(ROOT, ".git")):
        sys.exit("Not a git repo yet: see README, Hosting.")
    git("add", "site/data")
    if not git("diff", "--cached", "--quiet", check=False).returncode:
        print("Nothing new to publish.")
        return
    git("commit", "-m", "Scan " + time.strftime("%Y-%m-%d %H:%M"))
    if git("remote", check=False).stdout.strip():
        r = git("push", check=False)
        print("git push failed (the site still deploys):\n" + r.stderr if r.returncode else "Pushed to GitHub.")
    deploy()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", nargs="?", default="ingest", choices=["ingest", "serve", "publish", "deploy"])
    ap.add_argument("--wow", default=os.environ.get("AHSNAP_WOW", DEFAULT_WOW), help="the _forever_ folder")
    ap.add_argument("--port", type=int, default=8788)
    a = ap.parse_args()
    ingest(a.wow)
    if a.command == "serve":
        serve(a.port)
    elif a.command == "publish":
        publish()
    elif a.command == "deploy":
        deploy()


if __name__ == "__main__":
    main()
