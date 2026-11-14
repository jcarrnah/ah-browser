// AH Browser: reads data/realms.json, data/<realm>/latest.json and data/<realm>/history/NN.json
// (written by tools/ahsnap.py) and lets you browse the auction house as of the last scan.
"use strict";

const WOWHEAD = "classic";   // Wowhead site for icons and tooltips ("classic" = Classic Era)
const PAGE = 100;
const DEAL = 0.8;            // "Below usual" = lowest price at or under 80% of the usual market price

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SLOTS = {
  INVTYPE_HEAD: "Head", INVTYPE_NECK: "Neck", INVTYPE_SHOULDER: "Shoulder", INVTYPE_BODY: "Shirt",
  INVTYPE_CHEST: "Chest", INVTYPE_ROBE: "Chest", INVTYPE_WAIST: "Waist", INVTYPE_LEGS: "Legs", INVTYPE_FEET: "Feet",
  INVTYPE_WRIST: "Wrist", INVTYPE_HAND: "Hands", INVTYPE_FINGER: "Finger", INVTYPE_TRINKET: "Trinket",
  INVTYPE_CLOAK: "Back", INVTYPE_WEAPON: "One-hand", INVTYPE_SHIELD: "Off hand", INVTYPE_2HWEAPON: "Two-hand",
  INVTYPE_WEAPONMAINHAND: "Main hand", INVTYPE_WEAPONOFFHAND: "Off hand", INVTYPE_HOLDABLE: "Held in off hand",
  INVTYPE_RANGED: "Ranged", INVTYPE_RANGEDRIGHT: "Ranged", INVTYPE_THROWN: "Thrown", INVTYPE_RELIC: "Relic",
  INVTYPE_TABARD: "Tabard", INVTYPE_BAG: "Bag", INVTYPE_QUIVER: "Quiver", INVTYPE_AMMO: "Ammo",
};
const TIME_LEFT = ["?", "Short", "Medium", "Long", "Very long"];

const state = { realms: [], realm: null, data: null, rows: [], shown: [], sort: "name", dir: 1, page: 0, history: {} };

// ---------------------------------------------------------------- formatting

function money(c) {
  if (c == null) return '<span class="muted">–</span>';
  c = Math.round(c);
  const g = Math.floor(c / 10000), s = Math.floor(c / 100) % 100, k = c % 100;
  let out = "";
  if (g) out += `<span class="g">${g.toLocaleString()}<i>g</i></span>`;
  if (g || s) out += `<span class="s">${g ? String(s).padStart(2, "0") : s}<i>s</i></span>`;
  if (!g) out += `<span class="c">${s ? String(k).padStart(2, "0") : k}<i>c</i></span>`;
  return `<span class="money">${out}</span>`;
}

function moneyText(c) {   // short, for chart axes and tooltips
  if (c == null) return "–";
  c = Math.round(c);
  if (c === 0) return "0";
  if (c >= 10000) return (c / 10000).toLocaleString(undefined, { maximumFractionDigits: c >= 1e6 ? 0 : 2 }) + "g";
  if (c >= 100) return (c / 100).toLocaleString(undefined, { maximumFractionDigits: 1 }) + "s";
  return c + "c";
}

function ago(t) {
  const d = Date.now() / 1000 - t;
  if (d < 90) return "just now";
  if (d < 5400) return Math.round(d / 60) + " min ago";
  if (d < 129600) return Math.round(d / 3600) + " h ago";
  return Math.round(d / 86400) + " days ago";
}

const day = (t) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const stamp = (t) => new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function vs(r) {
  if (!r.usual || r.market == null) return "";
  const p = Math.round((r.market / r.usual - 1) * 100);
  if (!p) return '<span class="muted">±0%</span>';
  return `<span class="${p > 0 ? "up" : "down"}">${p > 0 ? "+" : ""}${p}%</span>`;
}

function itemId(key) { return key.split(".")[0]; }

function whLink(r, inner) {
  const [id, rand] = r.key.split(".");
  const href = `https://www.wowhead.com/${WOWHEAD}/item=${id}`;
  return `<a href="${href}" data-wowhead="item=${id}${rand ? "&rand=" + rand : ""}&domain=${WOWHEAD}" class="rq${r.quality ?? 1}">${inner}</a>`;
}

function refreshWowhead() {
  try { window.$WowheadPower?.refreshLinks?.(); window.WH?.Tooltips?.refreshLinks?.(); } catch (_) { /* tooltips are optional */ }
}

// ---------------------------------------------------------------- data

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(url + ": " + r.status);
  return r.json();
}

async function loadRealm(slug) {
  state.realm = state.realms.find((r) => r.slug === slug) || state.realms[0];
  state.history = {};
  const data = await getJSON(`data/${state.realm.slug}/latest.json`);
  const f = data.fields;
  state.data = data;
  state.rows = data.items.map((a) => {
    const r = {};
    f.forEach((k, i) => (r[k] = a[i]));
    r.vs = r.usual && r.market != null ? r.market / r.usual - 1 : null;
    r.lname = r.name.toLowerCase();
    return r;
  });
  $("#realm").value = state.realm.slug;
  $("#fresh").textContent = `Scanned ${ago(data.t)} (${stamp(data.t)}) · ${data.auctions.toLocaleString()} auctions · ${state.rows.length.toLocaleString()} items`;
  try { localStorage.setItem("ahb.realm", state.realm.slug); } catch (_) { /* storage is optional */ }
  fillTypes();
}

function fillTypes() {
  const types = [...new Set(state.rows.map((r) => r.type).filter(Boolean))].sort();
  $("#type").innerHTML = '<option value="">All categories</option>' + types.map((t) => `<option>${esc(t)}</option>`).join("");
  const slots = [...new Set(state.rows.map((r) => SLOTS[r.slot]).filter(Boolean))].sort();
  $("#slot").innerHTML = '<option value="">Any slot</option>' + slots.map((s) => `<option>${esc(s)}</option>`).join("");
}

function fillSubtypes() {
  const t = $("#type").value;
  const subs = t ? [...new Set(state.rows.filter((r) => r.type === t).map((r) => r.subtype).filter(Boolean))].sort() : [];
  const keep = $("#subtype").value;
  $("#subtype").innerHTML = '<option value="">All</option>' + subs.map((s) => `<option>${esc(s)}</option>`).join("");
  $("#subtype").value = subs.includes(keep) ? keep : "";
  $("#subtype").disabled = !t;
}

// ---------------------------------------------------------------- the list

function filter() {
  const q = $("#q").value.trim().toLowerCase();
  const type = $("#type").value, sub = $("#subtype").value, slot = $("#slot").value;
  const qual = $("#quality").value === "" ? null : +$("#quality").value;
  const lmin = $("#lmin").value === "" ? null : +$("#lmin").value;
  const lmax = $("#lmax").value === "" ? null : +$("#lmax").value;
  const deals = $("#deals").checked;
  const words = q.split(/\s+/).filter(Boolean);
  let rows = state.rows.filter((r) =>
    (!words.length || words.every((w) => r.lname.includes(w))) &&
    (!type || r.type === type) && (!sub || r.subtype === sub) && (!slot || SLOTS[r.slot] === slot) &&
    (qual == null || (r.quality ?? 1) >= qual) &&
    (lmin == null || (r.req || 0) >= lmin) && (lmax == null || (r.req || 0) <= lmax) &&
    (!deals || (r.usual && r.min != null && r.min <= r.usual * DEAL)));
  const k = state.sort, d = state.dir;
  rows.sort((a, b) => {
    const x = a[k], y = b[k];
    if (x == null && y == null) return a.lname < b.lname ? -1 : 1;
    if (x == null) return 1;           // blanks last either way
    if (y == null) return -1;
    if (k === "name") return d * (a.lname < b.lname ? -1 : a.lname > b.lname ? 1 : 0);
    return d * (x - y) || (a.lname < b.lname ? -1 : 1);
  });
  state.shown = rows;
}

function renderList() {
  const rows = state.shown, pages = Math.max(1, Math.ceil(rows.length / PAGE));
  state.page = Math.min(state.page, pages - 1);
  const slice = rows.slice(state.page * PAGE, (state.page + 1) * PAGE);
  $("#list tbody").innerHTML = slice.map((r) => `
    <tr tabindex="0" data-key="${esc(r.key)}">
      <td class="name">${whLink(r, esc(r.name))}<span class="sub">${esc([r.subtype || r.type, SLOTS[r.slot]].filter(Boolean).join(" · "))}</span></td>
      <td class="num hide-s">${r.req || ""}</td>
      <td class="num hide-s">${r.ilvl || ""}</td>
      <td class="num">${(r.qty || 0).toLocaleString()}</td>
      <td class="num">${money(r.min)}</td>
      <td class="num hide-s">${money(r.market)}</td>
      <td class="num hide-s">${vs(r)}</td>
    </tr>`).join("");
  $("#count").textContent = rows.length === state.rows.length
    ? `${rows.length.toLocaleString()} items` : `${rows.length.toLocaleString()} of ${state.rows.length.toLocaleString()} items`;
  $("#page").textContent = `Page ${state.page + 1} of ${pages}`;
  $("#prev").disabled = state.page === 0;
  $("#next").disabled = state.page >= pages - 1;
  document.querySelectorAll("#list th").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === state.sort);
    th.classList.toggle("asc", th.dataset.sort === state.sort && state.dir === 1);
  });
  refreshWowhead();
}

// ---------------------------------------------------------------- one item

async function loadHistory(key) {
  const shard = String(+itemId(key) % state.data.shards).padStart(2, "0");
  if (!state.history[shard]) state.history[shard] = await getJSON(`data/${state.realm.slug}/history/${shard}.json`).catch(() => ({}));
  return state.history[shard][key] || [];
}

async function showItem(key) {
  const r = state.rows.find((x) => x.key === key);
  if (!r) { location.hash = hashFor({ item: null }); return; }
  $("#browse").hidden = true;
  $("#item").hidden = false;
  window.scrollTo(0, 0);
  $("#i-name").innerHTML = whLink(r, esc(r.name));
  $("#i-meta").textContent = [r.type, r.subtype, SLOTS[r.slot], r.ilvl && `Item level ${r.ilvl}`, r.req && `Requires level ${r.req}`]
    .filter(Boolean).join(" · ");
  const stat = (label, html) => `<div class="stat"><b>${label}</b><span>${html}</span></div>`;
  $("#i-stats").innerHTML = [
    stat("Lowest buyout (each)", money(r.min)),
    stat("Market price (each)", money(r.market)),
    stat(`Usual (${state.data.usualDays || 14} days)`, r.usual ? `${money(r.usual)} ${vs(r)}` : '<span class="muted">needs more scans</span>'),
    stat("Available", `${(r.qty || 0).toLocaleString()} in ${r.auctions} auction${r.auctions === 1 ? "" : "s"}`),
    stat("Vendor sells for", money(r.vendor || null)),
  ].join("");
  $("#i-listings").innerHTML = `<thead><tr><th class="num">Stack</th><th class="num">Each</th><th class="num">Buyout</th>
    <th class="num hide-s">Bid</th><th class="hide-s">Time left</th><th class="num">Auctions</th></tr></thead><tbody>` +
    r.listings.map(([buy, bid, stack, tl, n]) => `<tr><td class="num">${stack}</td>
      <td class="num">${buy ? money(buy / stack) : '<span class="muted">bid only</span>'}</td>
      <td class="num">${buy ? money(buy) : ""}</td><td class="num hide-s">${money(bid || null)}</td>
      <td class="hide-s">${TIME_LEFT[tl] || "?"}</td><td class="num">${n}</td></tr>`).join("") + "</tbody>";
  refreshWowhead();
  $("#i-chart").innerHTML = '<p class="muted">Loading…</p>';
  const h = await loadHistory(key);
  if (new URLSearchParams(location.hash.slice(1)).get("item") !== key) return;   // moved on meanwhile
  chart($("#i-chart"), h);
  $("#i-hist-table table").innerHTML = `<thead><tr><th>Scan</th><th class="num">Lowest</th><th class="num">Market</th><th class="num">Available</th></tr></thead><tbody>` +
    h.slice().reverse().map(([t, lo, mkt, q]) => `<tr><td>${stamp(t)}</td><td class="num">${money(lo)}</td><td class="num">${money(mkt)}</td><td class="num">${q.toLocaleString()}</td></tr>`).join("") + "</tbody>";
}

// two lines on one money axis: market (series 1) and lowest (series 2); crosshair + tooltip on hover
function chart(el, h) {
  const pts = h.filter((p) => p[1] != null || p[2] != null);
  if (pts.length < 2) {
    el.innerHTML = `<p class="muted">${pts.length ? "One scan so far. The chart fills in as you scan more." : "No buyout prices recorded yet."}</p>`;
    return;
  }
  const series = [
    { name: "Market", i: 2, color: "var(--series-1)" },
    { name: "Lowest", i: 1, color: "var(--series-2)" },
  ];
  el.innerHTML = `<div class="legend">${series.map((s) => `<span style="--c:${s.color}">${s.name}</span>`).join("")}</div><svg role="img" aria-label="Price history"></svg>`;
  const svg = el.querySelector("svg");
  const W = svg.clientWidth || 600, H = 260, m = { l: 56, r: 56, t: 8, b: 24 };
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
  const top = Math.max(...pts.flatMap((p) => [p[1] || 0, p[2] || 0])) * 1.1 || 1;
  const step = niceStep(top / 4), ymax = Math.ceil(top / step) * step;
  const x = (t) => m.l + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - m.l - m.r);
  const y = (v) => H - m.b - (v / ymax) * (H - m.t - m.b);
  const ns = "http://www.w3.org/2000/svg";
  const add = (tag, attrs, text) => {
    const e = document.createElementNS(ns, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    svg.appendChild(e);
    return e;
  };
  for (let v = 0; v <= ymax + 1e-9; v += step) {
    add("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), stroke: "var(--grid)", "stroke-width": 1 });
    add("text", { x: m.l - 8, y: y(v) + 4, "text-anchor": "end", "font-size": 11, fill: "var(--ink-3)" }, moneyText(v));
  }
  const ticks = Math.min(5, pts.length);
  for (let i = 0; i < ticks; i++) {
    const t = t0 + ((t1 - t0) * i) / Math.max(1, ticks - 1);
    add("text", { x: x(t), y: H - 6, "text-anchor": i === 0 ? "start" : i === ticks - 1 ? "end" : "middle", "font-size": 11, fill: "var(--ink-3)" }, day(t));
  }
  const ends = [];
  for (const s of series) {
    const p = pts.filter((q) => q[s.i] != null);
    if (!p.length) continue;
    add("path", { d: p.map((q, j) => `${j ? "L" : "M"}${x(q[0]).toFixed(1)},${y(q[s.i]).toFixed(1)}`).join(""),
      fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" });
    if (p.length <= 20) for (const q of p) add("circle", { cx: x(q[0]), cy: y(q[s.i]), r: 4, fill: s.color, stroke: "var(--surface)", "stroke-width": 2 });
    const last = p[p.length - 1];
    ends.push({ s, y: y(last[s.i]) });
  }
  // direct labels at the right end, nudged apart when the lines finish close together
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  for (const e of ends) add("text", { x: W - m.r + 6, y: e.y + 4, "font-size": 12, fill: "var(--ink-2)" }, e.s.name);

  const cross = add("line", { y1: m.t, y2: H - m.b, stroke: "var(--ink-3)", "stroke-width": 1, visibility: "hidden" });
  const dots = series.map((s) => add("circle", { r: 5, fill: s.color, stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" }));
  const hit = add("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" });
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  el.appendChild(tip);
  const move = (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p[0]) - px) < Math.abs(x(best[0]) - px)) best = p;
    const bx = x(best[0]);
    cross.setAttribute("x1", bx); cross.setAttribute("x2", bx); cross.setAttribute("visibility", "visible");
    series.forEach((s, j) => {
      const v = best[s.i];
      dots[j].setAttribute("visibility", v == null ? "hidden" : "visible");
      if (v != null) { dots[j].setAttribute("cx", bx); dots[j].setAttribute("cy", y(v)); }
    });
    tip.innerHTML = `<div class="k">${stamp(best[0])}</div>` +
      series.map((s) => `<div><span class="sw" style="background:${s.color}"></span>${s.name}: ${money(best[s.i])}</div>`).join("") +
      `<div class="k">${best[3].toLocaleString()} available</div>`;
    tip.hidden = false;
    const left = (bx / W) * box.width + 12 + 12;
    tip.style.left = Math.min(left, el.clientWidth - tip.offsetWidth - 8) + "px";
    tip.style.top = "40px";
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", () => {
    tip.hidden = true;
    cross.setAttribute("visibility", "hidden");
    dots.forEach((d) => d.setAttribute("visibility", "hidden"));
  });
}

function niceStep(raw) {
  const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// ---------------------------------------------------------------- the address bar holds the view

const FIELDS = ["q", "type", "subtype", "slot", "quality", "lmin", "lmax"];

function hashFor(over) {
  const p = new URLSearchParams();
  p.set("r", state.realm?.slug || "");
  for (const f of FIELDS) if ($("#" + f).value) p.set(f, $("#" + f).value);
  if ($("#deals").checked) p.set("deals", "1");
  if (state.sort !== "name" || state.dir !== 1) p.set("sort", (state.dir < 0 ? "-" : "") + state.sort);
  if (state.page) p.set("p", state.page + 1);
  const item = "item" in over ? over.item : new URLSearchParams(location.hash.slice(1)).get("item");
  if (item) p.set("item", item);
  return "#" + p.toString();
}

function update(resetPage = true) {
  if (resetPage) state.page = 0;
  filter();
  renderList();
  history.replaceState(null, "", hashFor({ item: null }));
}

async function route() {
  const p = new URLSearchParams(location.hash.slice(1));
  const slug = p.get("r");
  if (slug && slug !== state.realm?.slug) await loadRealm(slug);
  const item = p.get("item");
  if (item) return showItem(item);
  $("#item").hidden = true;
  $("#browse").hidden = false;
}

// ---------------------------------------------------------------- start

async function start() {
  try {
    state.realms = await getJSON("data/realms.json");
  } catch (_) {
    state.realms = [];
  }
  if (!state.realms.length) {
    $("#browse").hidden = true;
    $("#empty").hidden = false;
    $("#empty").textContent = "No scans published yet. Scan in game with AHSnap, /reload, then run publish.";
    return;
  }
  $("#realm").innerHTML = state.realms.map((r) => `<option value="${esc(r.slug)}">${esc(r.label)}</option>`).join("");
  if (state.realms.length < 2) $("#realm").hidden = true;

  const p = new URLSearchParams(location.hash.slice(1));
  let saved = null;
  try { saved = localStorage.getItem("ahb.realm"); } catch (_) { /* storage is optional */ }
  await loadRealm(p.get("r") || saved || state.realms[0].slug);
  for (const f of FIELDS) if (p.get(f) != null) { $("#" + f).value = p.get(f); if (f === "type") fillSubtypes(); }
  fillSubtypes();
  if (p.get("subtype")) $("#subtype").value = p.get("subtype");
  $("#deals").checked = p.get("deals") === "1";
  const s = p.get("sort");
  if (s) { state.dir = s.startsWith("-") ? -1 : 1; state.sort = s.replace(/^-/, ""); }
  filter();
  state.page = Math.max(0, (+p.get("p") || 1) - 1);
  renderList();
  await route();

  let typing;
  $("#q").addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(update, 150); });
  $("#type").addEventListener("change", () => { fillSubtypes(); update(); });
  for (const id of ["#subtype", "#slot", "#quality", "#deals"]) $(id).addEventListener("change", () => update());
  for (const id of ["#lmin", "#lmax"]) $(id).addEventListener("input", () => update());
  $("#realm").addEventListener("change", async (e) => { await loadRealm(e.target.value); fillSubtypes(); update(); });
  document.querySelectorAll("#list th[data-sort]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    if (state.sort === k) state.dir = -state.dir;
    else { state.sort = k; state.dir = k === "name" ? 1 : k === "qty" || k === "ilvl" || k === "req" ? -1 : 1; }
    update();
  }));
  $("#prev").addEventListener("click", () => { state.page--; update(false); window.scrollTo(0, 0); });
  $("#next").addEventListener("click", () => { state.page++; update(false); window.scrollTo(0, 0); });
  const open = (ev) => {
    const tr = ev.target.closest("tr[data-key]");
    if (!tr) return;
    ev.preventDefault();
    location.hash = hashFor({ item: tr.dataset.key });
  };
  $("#list tbody").addEventListener("click", open);
  $("#list tbody").addEventListener("keydown", (ev) => { if (ev.key === "Enter") open(ev); });
  $("#back").addEventListener("click", () => { location.hash = hashFor({ item: null }); });
  window.addEventListener("hashchange", route);
}

start();
