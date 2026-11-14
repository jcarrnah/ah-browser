-- AHSnap: takes a full auction house scan and saves it for the AH Browser site (tools/ahsnap.py).
--
-- WoW Forever can expose either auction API, so both are supported and picked at run time:
--   legacy: QueryAuctionItems(..., getAll) -> GetNumAuctionItems / GetAuctionItemInfo("list", i)
--   modern: C_AuctionHouse.ReplicateItems() -> GetNumReplicateItems / GetReplicateItemInfo(i)
-- The server answers one full scan per account every 15 minutes. When another addon
-- (Auctionator, Crafter's Journal...) asks for one, AHSnap reads the same data instead.
--
-- Saved data (AHSnapDB), read by tools/ahsnap.py:
--   scans[realmKey] = { { t = unix time, n = auctions, api = "legacy"|"modern", d = { chunk, ... } }, ... }
--     newest last, KEEP_SCANS kept. chunk = "key:b/d/s/l/c,b/d/s/l/c;key:..." with one group per
--     set of identical auctions: b = buyout for the stack (0 = bid only), d = current or minimum bid
--     for the stack, s = stack size, l = time left (1 short .. 4 very long, 0 unknown), c = auctions
--   items[key] = "name|quality|itemLevel|reqLevel|type|subtype|equipLoc|icon|vendorPrice|stack|classID|subclassID"
--   lastRequest = when the last full scan was asked for (the cooldown runs from the request)
-- key = "itemID", or "itemID.suffixID" for random-suffix gear ("of the Bear")

local ADDON = ...

local PREFIX = "|cff33ccffAHSnap|r: "
local COOLDOWN = 15 * 60   -- seconds between full scans, per account (server rule)
local KEEP_SCANS = 5       -- scans kept per realm until the site tool picks them up
local TIMEOUT = 120        -- seconds to wait for the server to start answering
local STABLE_SECONDS = 4   -- the auction count must stop growing this long (data arrives in batches)
local FRAME_BUDGET_MS = 12 -- work per frame, keeps the game responsive
local BATCH_FALLBACK = 250 -- auctions per frame when there is no profiler clock
local RETRY_PASSES = 3     -- extra passes for auctions whose data had not loaded yet
local CHUNK_ITEMS = 200    -- items per saved string

local floor, max, min = math.floor, math.max, math.min
local GetInfo = (C_Item and C_Item.GetItemInfo) or GetItemInfo
local GetInstant = (C_Item and C_Item.GetItemInfoInstant) or GetItemInfoInstant

local db
local state = "idle"       -- idle, waiting, reading, saving
local run = 0              -- bumped to cancel queued work
local api, event, piggyback, ownRequest
local statusText = ""
local ahOpen = false
local muted, mutedEvent
local frame = CreateFrame("Frame")
local button, ticker

local function Print(msg)
  DEFAULT_CHAT_FRAME:AddMessage(PREFIX .. tostring(msg))
end

local function Countdown(sec)
  sec = max(0, floor(sec))
  return string.format("%d:%02d", floor(sec / 60), sec % 60)
end

local function RealmKey()
  local realm = (GetNormalizedRealmName and GetNormalizedRealmName()) or GetRealmName() or "Unknown"
  local faction = (UnitFactionGroup and UnitFactionGroup("player")) or "Neutral"
  return realm .. "-" .. tostring(faction)
end

local function SecondsLeft()
  if not (db and db.lastRequest) then return 0 end
  return max(0, COOLDOWN - (time() - db.lastRequest))
end

local function Api()
  if QueryAuctionItems then return "legacy" end
  if C_AuctionHouse and C_AuctionHouse.ReplicateItems then return "modern" end
  return nil
end

local function Count()
  if api == "legacy" then return (GetNumAuctionItems("list")) or 0 end
  return C_AuctionHouse.GetNumReplicateItems() or 0
end

-- "item:1234:0:0:0:0:0:567:..." -> "1234.567"; plain items -> "1234"
local function KeyFromLink(link)
  if type(link) ~= "string" then return nil end
  local body = link:match("item:([%-%d:]+)")
  local id = body and body:match("^(%d+)")
  if not id then return nil end
  local n = 0
  for field in (body .. ":"):gmatch("([^:]*):") do
    n = n + 1
    if n == 7 then
      if field ~= "" and field ~= "0" then return id .. "." .. field end
      break
    end
  end
  return id
end

---------------------------------------------------------------- the button on the auction house

local function Refresh()
  if not button then return end
  local wait = SecondsLeft()
  if state ~= "idle" then
    button:SetText(statusText)
    button:Disable()
  elseif wait > 0 then
    button:SetText("Next snapshot in " .. Countdown(wait))
    button:Disable()
  else
    button:SetText("Snapshot auction house")
    button:Enable()
  end
end

local function Status(text)
  statusText = text
  Refresh()
end

local Start -- (defined below)

local function ShowButton(show)
  local host = AuctionHouseFrame or AuctionFrame
  if show and host then
    if not button then
      -- parented to UIParent and only anchored to the auction window, so nothing of Blizzard's is touched
      button = CreateFrame("Button", "AHSnapButton", UIParent, "UIPanelButtonTemplate")
      button:SetSize(220, 24)
      button:SetScript("OnClick", function() Start() end)
      button:SetScript("OnEnter", function(self)
        GameTooltip:SetOwner(self, "ANCHOR_TOP")
        GameTooltip:SetText("AHSnap")
        GameTooltip:AddLine("Scans every auction (about a minute). Then /reload or log out,", 1, 1, 1)
        GameTooltip:AddLine("and run the publish script to update the AH Browser site.", 1, 1, 1)
        GameTooltip:AddLine("The server allows one full scan per account every 15 minutes.", 0.7, 0.7, 0.7)
        GameTooltip:Show()
      end)
      button:SetScript("OnLeave", GameTooltip_Hide)
    end
    button:ClearAllPoints()
    button:SetPoint("BOTTOMRIGHT", host, "TOPRIGHT", -30, 2)
    button:SetFrameStrata("HIGH")
    button:Show()
    if not ticker then ticker = C_Timer.NewTicker(1, Refresh) end
    Refresh()
  else
    if button then button:Hide() end
    if ticker then ticker:Cancel() ticker = nil end
  end
end

---------------------------------------------------------------- scanning

-- While tens of thousands of auctions arrive, the default UI would try to draw them all and
-- freeze the game, so other listeners are paused for our own request.
local function MuteOthers(ev)
  if not GetFramesRegisteredForEvent then return end
  local ok, list = pcall(function() return { GetFramesRegisteredForEvent(ev) } end)
  if not ok then return end
  muted, mutedEvent = list, ev
  for _, f in ipairs(list) do
    if f ~= frame then pcall(f.UnregisterEvent, f, ev) end
  end
end

local function UnmuteOthers()
  if not muted then return end
  for _, f in ipairs(muted) do
    if f ~= frame then pcall(f.RegisterEvent, f, mutedEvent) end
  end
  muted, mutedEvent = nil, nil
end

local function Stop(msg)
  frame:UnregisterAllEvents()
  frame:RegisterEvent("AUCTION_HOUSE_SHOW")
  frame:RegisterEvent("AUCTION_HOUSE_CLOSED")
  UnmuteOthers()
  state = "idle"
  run = run + 1
  if msg then Print(msg) end
  Status("")
end

local function ReadAuction(i)
  local f = api == "legacy" and function(j) return GetAuctionItemInfo("list", j) end or C_AuctionHouse.GetReplicateItemInfo
  local name, texture, count, quality, _, level, _, minBid, _, buyout, bidAmount, _, _, _, _, _, itemID = f(i)
  return name, texture, count, quality, level, minBid, buyout, bidAmount, itemID
end

local function ReadLink(i)
  local fn = api == "legacy" and GetAuctionItemLink or (C_AuctionHouse.GetReplicateItemLink)
  if not fn then return nil end
  local ok, link
  if api == "legacy" then ok, link = pcall(fn, "list", i) else ok, link = pcall(fn, i) end
  return ok and link or nil
end

local function ReadTimeLeft(i)
  local ok, tl
  if api == "legacy" then
    if not GetAuctionItemTimeLeft then return 0 end
    ok, tl = pcall(GetAuctionItemTimeLeft, "list", i)
  else
    if not C_AuctionHouse.GetReplicateItemTimeLeft then return 0 end
    ok, tl = pcall(C_AuctionHouse.GetReplicateItemTimeLeft, i)
  end
  return (ok and tonumber(tl)) or 0
end

local function Clean(s)
  return (tostring(s or ""):gsub("|", "/"))
end

-- item details for the site: what the auction told us plus what the client knows about the item
local function SaveItem(key, seen)
  local id = tonumber(key:match("^(%d+)"))
  local old = {}
  if db.items[key] then
    for field in (db.items[key] .. "|"):gmatch("([^|]*)|") do old[#old + 1] = field end
  end
  local _, itype, isub, equip, icon, classID, subclassID
  if GetInstant then
    local ok, a, b, c, d, e, f, g = pcall(GetInstant, id)
    if ok then _, itype, isub, equip, icon, classID, subclassID = a, b, c, d, e, f, g end
  end
  local ilvl, req, stack, sell
  if GetInfo then
    local ok, _, _, _, l, r, t2, s2, st, e2, ic2, sp, c2, sc2 = pcall(GetInfo, id)
    if ok then
      ilvl, req, stack, sell = l, r, st, sp
      itype, isub, equip, icon = itype or t2, isub or s2, equip or e2, icon or ic2
      classID, subclassID = classID or c2, subclassID or sc2
    end
  end
  local function pick(new, i)
    if new ~= nil and new ~= "" then return Clean(new) end
    return old[i] or ""
  end
  db.items[key] = table.concat({
    pick(seen.name, 1), pick(seen.quality, 2), pick(ilvl, 3), pick(req or seen.level, 4),
    pick(itype, 5), pick(isub, 6), pick(equip, 7), pick(icon or seen.texture, 8),
    pick(sell, 9), pick(stack, 10), pick(classID, 11), pick(subclassID, 12),
  }, "|")
end

local function Finish(groups, seen, total, read)
  if read == 0 then
    Stop("The server returned no auctions; nothing saved. Try again later.")
    return
  end
  state = "saving"
  local id = run
  local keys = {}
  for key in pairs(groups) do keys[#keys + 1] = key end
  table.sort(keys)
  local chunks, buf, pos, n = {}, {}, 1, #keys

  local function Done()
    if #buf > 0 then chunks[#chunks + 1] = table.concat(buf, ";") end
    local realm = RealmKey()
    db.scans[realm] = db.scans[realm] or {}
    local list = db.scans[realm]
    list[#list + 1] = { t = time(), n = total, api = api, d = chunks }
    while #list > KEEP_SCANS do table.remove(list, 1) end
    local msg = string.format("Saved %d auctions of %d different items.", total, n)
    if read < total then msg = msg .. string.format(" (%d had no data and were skipped.)", total - read) end
    Stop(msg)
    Print("Now /reload (or log out) so the game writes it to disk, then run publish.")
  end

  local function Step()
    if run ~= id then return end
    local t0 = debugprofilestop and debugprofilestop()
    local stop = t0 and n or min(pos + 100, n)
    while pos <= stop do
      local key = keys[pos]
      local parts = {}
      for g, c in pairs(groups[key]) do parts[#parts + 1] = g .. "/" .. c end
      table.sort(parts)
      buf[#buf + 1] = key .. ":" .. table.concat(parts, ",")
      SaveItem(key, seen[key])
      if #buf >= CHUNK_ITEMS then
        chunks[#chunks + 1] = table.concat(buf, ";")
        buf = {}
      end
      pos = pos + 1
      if t0 and pos % 20 == 0 and debugprofilestop() - t0 > FRAME_BUDGET_MS then break end
    end
    Status(string.format("Saving %d / %d", min(pos - 1, n), n))
    if pos <= n then C_Timer.After(0, Step) else Done() end
  end
  Step()
end

local function Read()
  pcall(frame.UnregisterEvent, frame, event)
  state = "reading"
  local id = run
  local first = api == "legacy" and 1 or 0
  local total = Count()
  local groups, seen, pending, read = {}, {}, {}, 0

  local function Take(i)
    local name, texture, count, quality, level, minBid, buyout, bidAmount, itemID = ReadAuction(i)
    if not itemID or itemID <= 0 or not count or count <= 0 or not name or name == "" then return false end
    local key = tostring(itemID)
    if quality and quality >= 2 then key = KeyFromLink(ReadLink(i)) or key end
    local bid = (bidAmount and bidAmount > 0) and bidAmount or (minBid or 0)
    local g = floor(buyout or 0) .. "/" .. floor(bid) .. "/" .. count .. "/" .. ReadTimeLeft(i)
    local list = groups[key]
    if not list then
      list = {}
      groups[key] = list
      seen[key] = { name = name, quality = quality, level = level, texture = texture }
    end
    list[g] = (list[g] or 0) + 1
    read = read + 1
    return true
  end

  -- runs Take over a list of indices a slice per frame, then calls done()
  local function Batched(indices, label, done)
    local pos, n = 1, #indices
    local function Step()
      if run ~= id then return end
      local t0 = debugprofilestop and debugprofilestop()
      local stop = t0 and n or min(pos + BATCH_FALLBACK - 1, n)
      while pos <= stop do
        if not Take(indices[pos]) then pending[#pending + 1] = indices[pos] end
        pos = pos + 1
        if t0 and pos % 50 == 0 and debugprofilestop() - t0 > FRAME_BUDGET_MS then break end
      end
      Status(string.format("%s %d / %d", label, min(pos - 1, n), n))
      if pos <= n then C_Timer.After(0, Step) else done() end
    end
    Step()
  end

  local function Retry(pass)
    if #pending == 0 or pass > RETRY_PASSES then return Finish(groups, seen, total, read) end
    local again = pending
    pending = {}
    C_Timer.After(1, function()
      if run ~= id then return end
      Batched(again, "Loading items", function() Retry(pass + 1) end)
    end)
  end

  local all = {}
  for i = first, first + total - 1 do all[#all + 1] = i end
  Batched(all, "Reading", function()
    local now = Count() -- a late batch may have arrived while reading
    if now > total then
      local extra = {}
      for i = first + total, first + now - 1 do extra[#extra + 1] = i end
      total = now
      Batched(extra, "Reading", function() Retry(1) end)
    else
      Retry(1)
    end
  end)
end

-- pb = another addon made the request; we only read what arrives
local function Begin(a, pb)
  api, piggyback = a, pb
  event = a == "legacy" and "AUCTION_ITEM_LIST_UPDATE" or "REPLICATE_ITEM_LIST_UPDATE"
  state = "waiting"
  run = run + 1
  db.lastRequest = time()
  if not pb then MuteOthers(event) end
  pcall(frame.RegisterEvent, frame, event)

  local before = Count()
  if not pb then
    ownRequest = true
    if a == "legacy" then
      -- the stock UI errors on quality -1 entries during a getAll
      if ITEM_QUALITY_COLORS and not ITEM_QUALITY_COLORS[-1] then ITEM_QUALITY_COLORS[-1] = { r = 0, g = 0, b = 0 } end
      pcall(QueryAuctionItems, "", nil, nil, 0, nil, nil, true, false, nil)
    else
      pcall(C_AuctionHouse.ReplicateItems)
    end
    ownRequest = false
  end

  local id, started = run, GetTime()
  local last, stable, changed, gotEvent = before, 0, false, false
  frame.gotEvent = function() gotEvent = true end
  local function Tick()
    if run ~= id or state ~= "waiting" then return end
    local elapsed = floor(GetTime() - started)
    local count = Count()
    changed = changed or count ~= before
    local arriving = count > 0 and (changed or gotEvent)
    if elapsed >= TIMEOUT and not arriving then
      Stop(not pb and ("The server did not answer. Next try in " .. Countdown(SecondsLeft()) .. ".") or nil)
      return
    end
    if arriving then
      if count == last then
        stable = stable + 1
        if stable >= STABLE_SECONDS then return Read() end
      else
        stable = 0
      end
    end
    last = count
    Status(string.format(pb and "Reading along... %d" or "Waiting... %d", count))
    C_Timer.After(1, Tick)
  end
  Tick()
end

Start = function()
  if state ~= "idle" then Print("A scan is already running.") return end
  if not ahOpen then Print("Open the auction house first.") return end
  local wait = SecondsLeft()
  if wait > 0 then Print("The server allows one full scan every 15 minutes. Next in " .. Countdown(wait) .. ".") return end
  local a = Api()
  if not a then Print("No auction scan API found in this client.") return end
  if a == "legacy" and CanSendAuctionQuery then
    local _, canGetAll = CanSendAuctionQuery()
    if not canGetAll then
      Print("The server isn't accepting a full scan yet (another addon may have scanned). Try again in a few minutes.")
      return
    end
  end
  Begin(a, false)
end

-- another addon asked for a full scan: note the cooldown and read along
local function OnForeignScan(a)
  if ownRequest or not db then return end
  db.lastRequest = time()
  if state ~= "idle" or not ahOpen then return end
  Begin(a, true)
end

local hookedReplicate, hookedQuery
local function InstallHooks()
  if C_AuctionHouse and C_AuctionHouse.ReplicateItems and C_AuctionHouse.ReplicateItems ~= hookedReplicate then
    pcall(hooksecurefunc, C_AuctionHouse, "ReplicateItems", function() OnForeignScan("modern") end)
    hookedReplicate = C_AuctionHouse.ReplicateItems
  end
  if QueryAuctionItems and QueryAuctionItems ~= hookedQuery then
    pcall(hooksecurefunc, "QueryAuctionItems", function(_, _, _, _, _, _, getAll)
      if getAll then OnForeignScan("legacy") end
    end)
    hookedQuery = QueryAuctionItems
  end
end

---------------------------------------------------------------- events and slash command

frame:SetScript("OnEvent", function(_, ev, arg1)
  if ev == "ADDON_LOADED" then
    if arg1 ~= ADDON then return end
    AHSnapDB = type(AHSnapDB) == "table" and AHSnapDB or {}
    db = AHSnapDB
    db.version = 1
    db.scans = type(db.scans) == "table" and db.scans or {}
    db.items = type(db.items) == "table" and db.items or {}
    InstallHooks()
  elseif ev == "AUCTION_HOUSE_SHOW" then
    ahOpen = true
    InstallHooks()
    ShowButton(true)
  elseif ev == "AUCTION_HOUSE_CLOSED" then
    ahOpen = false
    if state == "waiting" or state == "reading" then Stop("Scan stopped: the auction house closed.") end
    ShowButton(false)
  elseif ev == event and state == "waiting" and frame.gotEvent then
    frame.gotEvent()
  end
end)
frame:RegisterEvent("ADDON_LOADED")
frame:RegisterEvent("AUCTION_HOUSE_SHOW")
frame:RegisterEvent("AUCTION_HOUSE_CLOSED")

SLASH_AHSNAP1 = "/ahsnap"
SlashCmdList.AHSNAP = function(msg)
  msg = (msg or ""):lower():match("^%s*(.-)%s*$")
  if msg == "cancel" then
    if state == "idle" then Print("No scan is running.") else Stop("Scan cancelled.") end
  elseif msg == "status" then
    local list = db.scans[RealmKey()] or {}
    local last = list[#list]
    Print(string.format("%s: %d scan(s) waiting to be published%s. API: %s. Next full scan in %s.",
      RealmKey(), #list, last and (", newest " .. date("%b %d %H:%M", last.t)) or "",
      Api() or "none", Countdown(SecondsLeft())))
  elseif msg == "" or msg == "scan" then
    Start()
  else
    Print("/ahsnap - scan (auction house open)   /ahsnap status   /ahsnap cancel")
  end
end
