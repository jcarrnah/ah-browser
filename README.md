# AH Browser

Browse the WoW Forever auction house from anywhere, as of your last scan, with price history.

- `addon/AHSnap/`: the in-game addon. It takes a full auction house scan and saves it.
- `tools/ahsnap.py`: turns the saved scans into the static site's data (`site/data/`). Python 3, standard library only.
- `site/`: the website. Plain HTML/JS/CSS, no build step, so any static host serves it.

## Taking a snapshot

1. In game, open the auction house and click **Snapshot auction house** (above the auction window), or type `/ahsnap`.
   It takes about a minute. The server allows one full scan per account every 15 minutes, and the button shows
   the countdown. If Auctionator or Crafter's Journal does a full scan, AHSnap reads along and saves it too.
2. `/reload` or log out. WoW only writes addon data to disk then.
3. Double-click `publish.cmd`. It adds the new scan(s) to `site/data` and pushes them, and the site updates.
   `preview.cmd` shows the site locally at http://localhost:8788 instead.

The addon keeps the last 5 scans per realm, so you can scan several times before publishing.
`/ahsnap status` shows how many are waiting.

## What the site shows

- Every item listed at the time of the scan: search, category, slot, rarity, level range, sorting.
- **Lowest**: the cheapest buyout per item. **Market**: the per-item price 15% of the way into the stock, which skips a
  few oddly cheap listings. **vs usual**: market price against its median over the last 14 days (needs 2+ earlier scans).
  **Below usual** filters to items whose lowest price is at or under 80% of usual.
- An item's page: its listings (stack, each, buyout, bid, time left) and a price history chart.
- Icons and tooltips come from Wowhead's Classic database (`WOWHEAD` at the top of `site/app.js`). Items Wowhead
  doesn't know still show, without an icon.

## Hosting

The site is static files. The published `site/data` files are the price history too: each scan is appended to them,
so the git repo is the archive.

**Cloudflare Pages** (like 77th-calendar): push this repo to GitHub, then in Cloudflare create a Pages project from it
with no build command and output directory `site`. Every `publish.cmd` push deploys. Pages sites are public; put
Cloudflare Access in front if you'd rather they weren't.

**Unraid**: serve `site/` with any web server container (nginx, Caddy), from a clone of the repo that a User
Scripts job keeps current with `git pull` (e.g. hourly), and expose it through the Cloudflare tunnel.

## Setup on a PC

1. `powershell -ExecutionPolicy Bypass -File install.ps1` links `addon\AHSnap` into the game's AddOns folder
   (`-Wow "<path>\_forever_"` for another install). Enable AHSnap in the AddOns list.
2. Install Python 3. If WoW isn't in `C:\BNET\World of Warcraft\_forever_`, set `AHSNAP_WOW` to the `_forever_` folder.
