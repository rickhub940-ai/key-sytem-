-- ===========================================================
-- 999MS Payload — UI + Platoboost + Anti-Save (แบบไฟล์ X)
-- ===========================================================
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local CoreGui = game:GetService("CoreGui")
local LocalPlayer = Players.LocalPlayer

-- Display an opaque local reference rather than exposing a human-readable
-- client-side check reason in Roblox's error prompt.
local function makeKickCode(reason)
    local text = tostring(reason or "unknown")
    local hash = 5381
    for index = 1, #text do
        hash = (hash * 33 + text:byte(index) + index) % 2147483647
    end
    return string.format("MS9-%08X", hash)
end

local function patchErrorPrompt(code)
    local success, changed = pcall(function()
        local root = CoreGui:FindFirstChild("RobloxPromptGui")
        local overlay = root and root:FindFirstChild("promptOverlay")
        local prompt = overlay and overlay:FindFirstChild("ErrorPrompt")
        local titleFrame = prompt and prompt:FindFirstChild("TitleFrame")
        local title = titleFrame and titleFrame:FindFirstChild("ErrorTitle")
        local messageArea = prompt and prompt:FindFirstChild("MessageArea")
        local errorFrame = messageArea and messageArea:FindFirstChild("ErrorFrame")
        local label = errorFrame and errorFrame:FindFirstChild("ErrorMessage")
        if not title or not label then return false end
        title.Text = "[999MS]"
        label.Text = "Session terminated.\nReference: " .. code
        return true
    end)
    return success and changed
end

local function Kick(reason)
    local code = makeKickCode(reason)
    pcall(function()
        CoreGui.ChildAdded:Connect(function(child)
            if child.Name == "RobloxPromptGui" then
                task.spawn(function()
                    task.wait(0.01)
                    patchErrorPrompt(code)
                end)
            end
        end)
    end)
    task.spawn(function()
        for _ = 1, 50 do
            if patchErrorPrompt(code) then break end
            task.wait(0.01)
        end
    end)
    -- Best-effort executor signal trigger requested for compatible executors.
    -- It is not a portable disconnect primitive, so LocalPlayer:Kick remains
    -- the fail-closed fallback that actually enforces the disconnect.
    pcall(function()
        if type(replicatesignal) == "function" and LocalPlayer.StatsAvailable then
            replicatesignal(LocalPlayer.StatsAvailable, "Kick")
        end
    end)
    return LocalPlayer:Kick(code)
end

local RunService = game:GetService("RunService")

local BASE_URL = "@BASE_URL@"
local CHAIN_VERSION = "999MS-chain-v1"
local CHAIN_TTL = 20
local CHAIN_SESSION_TTL = 30 * 60

local G0 = getgenv
if type(G0) ~= "function" then return Kick("[999MS] Environment unavailable") end
local E0 = G0()
if type(E0) ~= "table" then return Kick("[999MS] Environment invalid") end
local ChainEnv = E0
local Chain = ChainEnv.MS999Chain
local ChainId = type(Chain) == "table" and Chain.Id or nil
local function chainIs(stage, maxAge)
    local current = ChainEnv.MS999Chain
    return current == Chain
        and type(current) == "table"
        and current.Version == CHAIN_VERSION
        and type(current.Id) == "string"
        and current.Id == ChainId
        and current.Stage == stage
        and type(current.UpdatedAt) == "number"
        and tick() - current.UpdatedAt >= 0
        and tick() - current.UpdatedAt <= maxAge
end

if not chainIs("loader", CHAIN_TTL) then
    return Kick("[999MS] Chain rejected: run loadc.lua")
end

-- ═══ L1-L3: Loader Proof ═══
local LoaderProof = E0.MS999LoaderProof
local LoaderTime = E0.MS999LoaderTime
local LoaderMarker = E0.MS999LoaderMarker

if type(LoaderProof) ~= "string" then
    return Kick("[999MS] L1: Not run via loader")
end
if not LoaderProof:match("^999MS_loader_v1:[a-z]+$") then
    return Kick("[999MS] L1: Invalid proof")
end
if not LoaderTime or (tick() - LoaderTime) > 10 then
    return Kick("[999MS] L2: Proof expired")
end
if type(LoaderMarker) ~= "string" or not LoaderMarker:match("^LSE_%d+$") then
    return Kick("[999MS] L3: Invalid marker")
end
if not chainIs("loader", CHAIN_TTL) then
    return Kick("[999MS] Chain interrupted before payload")
end
Chain.Stage = "payload"
Chain.UpdatedAt = tick()

-- ═══ Signal bus ═══
local MS999Signal = E0.MS999Signal
if type(MS999Signal) ~= "table" then
    return Kick("[999MS] Signal bus missing")
end

-- ═══ Capture real ═══
-- Stage 2 may expose its trusted write monitor through E0 while the
-- executor's global writefile alias is a different reference. Prefer the
-- Stage-2 reference so a normal executor alias split is not a false positive.
local Stage2WriteMonitor = E0.MS999WriteMonitor
local RealWriteFile = type(Stage2WriteMonitor) == "function" and Stage2WriteMonitor or writefile
local RealIsHooked = isfunctionhooked
local RealDebugGetInfo = debug.getinfo
local RealHookFunction = hookfunction
local RealRawset = rawset
local RealRawget = rawget
local RealLoadstring = loadstring

-- ═══ L4-L6: hook check ═══
if type(RealWriteFile) == "function" then
    local info = RealDebugGetInfo(RealWriteFile)
    if not info or info.what ~= "C" then
        return Kick("[999MS] L4: writefile wrapped")
    end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, RealWriteFile)
        local stageTwoMonitor = E0.MS999WriteMonitor
        if ok and hooked and stageTwoMonitor ~= RealWriteFile then
            return Kick("[999MS] L4: writefile hooked")
        end
    end
end

if type(RealHookFunction) == "function" then
    local info = RealDebugGetInfo(RealHookFunction)
    if not info or info.what ~= "C" then
        return Kick("[999MS] L5: hookfunction wrapped")
    end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, RealHookFunction)
        if ok and hooked then
            return Kick("[999MS] L5: hookfunction hooked")
        end
    end
end

if type(RealRawset) == "function" then
    local info = RealDebugGetInfo(RealRawset)
    if not info or info.what ~= "C" then
        return Kick("[999MS] L6: rawset wrapped")
    end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, RealRawset)
        if ok and hooked then
            return Kick("[999MS] L6: rawset hooked")
        end
    end
end

print("[999MS] Payload L1-L6 passed")

-- ===========================================================
-- Anti-Save
--
-- The loader owns the writefile monitor and sends detections through
-- MS999Signal.OnDetect. Do not install a second hook here: it would require
-- a non-standard env.Signal API and make the loader's hook look like tampering
-- during this payload's L4 preflight.
-- ===========================================================

-- ═══ Locals ═══
local SCRIPT_NAME = E0.script or _G.script or "main"
local SCRIPT_NAME_LOCKED = SCRIPT_NAME
-- Key may be pre-seeded by unrelated executor scripts; only a string is a key.
-- A function/table here would otherwise be assigned to TextBox.Text at UI startup.
local USER_KEY = type(E0.Key) == "string" and E0.Key
    or (type(_G.Key) == "string" and _G.Key or "")
local E1 = ""
-- Capture the caller's one-shot key locally; never keep or re-publish it in
-- the shared executor environment.
E0.Key = nil
_G.Key = nil

local Char = ("").char
local Byte = ("").byte
local Gmatch = ("").gmatch

local ServerId = ""
local XORKey = ""
local Ticket = ""
-- Every guarded stage bumps this. A chapter that is skipped (early return
-- injected by a hook) leaves the count short and is caught at the hand-off.
local Step = 0
local STEP_TARGET = 4
local HttpRequest = nil
local HeartbeatAlive = false
local ChecksActive = true

-- ═══ Helpers ═══
local function SecureCrash()
    if NfCrash then NfCrash() else while true do end end
end

-- Stop all post-load monitoring and discard this loader's session state. The
-- stage-2 write hook is disabled through MS999ChecksActive because executors
-- do not provide a portable, safe unhook API.
local function StopChecks()
    if not ChecksActive then return end
    ChecksActive = false
    HeartbeatAlive = false
    Ticket = ""
    ServerId = ""
    XORKey = ""

    local env = E0
    if env.MS999Chain == Chain and type(Chain) == "table" and Chain.Id == ChainId then
        env.MS999Chain = nil
    end
    local stopStageTwo = env.MS999StopChecks
    if type(stopStageTwo) == "function" then
        pcall(stopStageTwo)
    else
        env.MS999ChecksActive = false
        env.MS999WriteMonitor = nil
    end

    env.MS999Loader = nil
    env.MS999Ticket = nil
    env.MS999Token = nil
    env.MS999Secret = nil
    env.MS999Session = nil
    env.MS999Hop = nil
    env.MS999Script = nil
    env.MS999LoadTime = nil
    env.MS999Signal = nil
    env.MS999Request = nil
    env.MS999RequestAudit = nil
    env.Key = nil
    _G.Key = nil
    env.MS999 = nil
    _G.MS999 = nil
    MS999 = nil
end

local function KickPlayer(Reason, Code)
    local detail = tostring(Reason)
    print("[999MS] Kick:", makeKickCode(detail))
    if Code == 0 and rawequal(Code, 0) then
        Kick(detail)
    elseif Code == 1 and rawequal(Code, 1) then
        Kick(detail)
        if math.random() == math.random() then SecureCrash() end
        task.wait(math.random(13, 28))
        SecureCrash()
    else
        Kick(detail)
    end
end

local function TamperKick(code)
    pcall(function()
        Kick("[999MS] Tamper detected (" .. code .. ")")
    end)
    task.wait(0.3)
    SecureCrash()
end

local function SecureEQ(a, b)
    if type(a) ~= type(b) then return false end
    local T = {}
    if a ~= b then return false end
    T[a] = 3569
    if T[b] ~= 3569 then return false end
    T[b] = nil
    if T[a] ~= nil then return false end
    return true
end

local function Split(str, sep)
    local out = {}
    for p in Gmatch(str, "([^" .. sep .. "]+)") do
        table.insert(out, p)
    end
    return out
end

local function GetHWID()
    -- Only accept executor-native getters. A Lua callback from getgenv/_G is
    -- caller-controlled and must never become the device binding.
    local fs = {}
    local f = type(syn) == "table" and syn.get_hwid or nil
    if f then fs[#fs + 1] = f end
    f = get_hwid
    if f then fs[#fs + 1] = f end
    f = gethwid
    if f then fs[#fs + 1] = f end
    for _, f in ipairs(fs) do
        if type(f) == "function" then
            local o, i = pcall(RealDebugGetInfo, f)
            if o and type(i) == "table" and i.what == "C" then
                local h = false
                if type(RealIsHooked) == "function" then
                    local q
                    q, h = pcall(RealIsHooked, f)
                    if not q then h = true end
                end
                if not h then
                    local q, v = pcall(f)
                    if q and type(v) == "string" and #v >= 4 and #v <= 512 then return v end
                end
            end
        end
    end
    -- Some executors expose no HWID getter. The Roblox client ID is a stable
    -- engine-issued fallback, unlike AccountAge/UserId or a caller Lua closure.
    local q, v = pcall(function()
        return game:GetService("RbxAnalyticsService"):GetClientId()
    end)
    if q and type(v) == "string" and #v >= 16 and #v <= 512 then return v end
    return nil
end

-- ═══ T2-T19 ═══
if E0.MS999 and MS999 and _G.MS999 then return end
E0.MS999 = true
MS999 = true
_G.MS999 = true

if RunService:IsStudio() then return TamperKick("T2") end

do
    -- Test normal protected execution instead of calling pcall with an invalid
    -- signature; some executors implement that edge case differently.
    local ok, value = pcall(function() return 3569 end)
    if not ok or value ~= 3569 then return TamperKick("T3") end
end

local function CheckFn(name, fn)
    if type(fn) ~= "function" then TamperKick("T4:" .. name); return false end
    -- Compatible mode: only perform the hook audit when this executor exposes
    -- it. A C-closure appearance alone is not treated as proof of authenticity.
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, fn)
        if not ok or hooked then TamperKick("T4:" .. name); return false end
    end
    return true
end

if type(RealIsHooked) == "function" and not CheckFn("isfunctionhooked", RealIsHooked) then return end
if not CheckFn("debug.getinfo", debug.getinfo) then return end
if not CheckFn("loadstring", loadstring) then return end
if not CheckFn("pcall", pcall) then return end
if not CheckFn("math.random", math.random) then return end

do
    if math.random(1, 2) == math.random(3, 4) then return TamperKick("T5") end
    local Same, Last = 0, 0
    for _ = 1, 100 do
        local Cur = math.random(1, 3569)
        if Cur == Last then Same = Same + 1 end
        Last = Cur
    end
    if Same > 10 then return TamperKick("T5") end
end

do
    local test = {}
    E0.__MS999_test = test
    if E0.__MS999_test ~= test or getgenv ~= G0 then return TamperKick("T6") end
    E0.__MS999_test = nil
end

local SafeLoadstring = loadstring
local SafeGetGenv = function() return E0 end
local SafeSetClipboard = setclipboard or toclipboard

do
    if type(SafeLoadstring) ~= "function" then return TamperKick("T13") end
    local info = debug.getinfo(SafeLoadstring)
    if not info or info.what ~= "C" then return TamperKick("T13") end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, SafeLoadstring)
        if not ok or hooked then return TamperKick("T13") end
    end
    if SafeGetGenv().loadstring ~= SafeLoadstring then return TamperKick("T13") end
    local ok, fn = pcall(SafeLoadstring, "return 1 + 1")
    if not ok or type(fn) ~= "function" then return TamperKick("T13") end
    local ok2, result = pcall(fn)
    if not ok2 or result ~= 2 then return TamperKick("T13") end
end

if type(hookfunction) == "function" and type(RealIsHooked) == "function" then
    local ok, hooked = pcall(RealIsHooked, hookfunction)
    if not ok or hooked then return TamperKick("T16") end
end

-- Use the request function captured and audited by the loader instead of
-- resolving a fresh global alias that may have been replaced afterwards.
do
    local capturedRequest = SafeGetGenv().MS999Request
    if type(capturedRequest) ~= "function" then
        return TamperKick("HTTP: missing captured request")
    end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, capturedRequest)
        if not ok or hooked then
            return TamperKick("HTTP: request hooked")
        end
    end
    HttpRequest = capturedRequest
end

print("[999MS] Payload tamper checks passed")

-- ═══ Crypto ═══
local Charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

local function Xor(data, key)
    local out = ""
    for i = 1, #data do
        out = out .. Char(bit32.bxor(data:byte(i), key:byte((i - 1) % #key + 1)))
    end
    return out
end

local function Base64(str)
    local out = ""
    for i = 1, #str, 3 do
        local a, b, c = str:byte(i, i + 2)
        a, b, c = a or 0, b or 0, c or 0
        local n = bit32.lshift(a, 16) + bit32.lshift(b, 8) + c
        local s1 = bit32.rshift(n, 18) % 64
        local s2 = bit32.rshift(n, 12) % 64
        local s3 = bit32.rshift(n, 6) % 64
        local s4 = n % 64
        out = out .. Charset:sub(s1 + 1, s1 + 1) .. Charset:sub(s2 + 1, s2 + 1)
        if i + 1 > #str then
            out = out .. "=="
        elseif i + 2 > #str then
            out = out .. Charset:sub(s3 + 1, s3 + 1) .. "="
        else
            out = out .. Charset:sub(s3 + 1, s3 + 1) .. Charset:sub(s4 + 1, s4 + 1)
        end
    end
    return out
end

local function Base64Decode(str)
    str = str:gsub("-", "+"):gsub("_", "/")
    while #str % 4 ~= 0 do str = str .. "=" end
    local out = ""
    local buffer, bits = 0, 0
    for i = 1, #str do
        local c = str:sub(i, i)
        if c ~= "=" then
            local v = Charset:find(c, 1, true)
            if v then
                buffer = bit32.lshift(buffer, 6) + (v - 1)
                bits = bits + 6
                if bits >= 8 then
                    bits = bits - 8
                    out = out .. Char(bit32.rshift(buffer, bits) % 256)
                end
            end
        end
    end
    return out
end

-- ═══ RNG ═══
local function Floor(n)
    if n >= 0 then return n - (n % 1) end
    if n % 1 == 0 then return n end
    return n - (n % 1) - 1
end
local function Abs(n) return n < 0 and -n or n end

local function Equate(X)
    X = X + 73
    local Y = (X % 11) ^ 3 + (X % 5) * 97 + Floor(X / 3)
    if X ~= 0 then Y = Y + (X * 37) - ((X % 9) ^ 2)
    else Y = Abs(Y) + 137 end
    return (Y * 7919 + 1234567) % 100000000000003
end

local ChallengeMultipliers = { 2, 5, 3, 7, 11 }
local ChallengeOffsets = { -32, 256, -17, 19, -101 }
local function RestoreChallenge(index, value)
    if type(value) ~= "number" then return nil end
    local restored = (value - ChallengeOffsets[index]) / ChallengeMultipliers[index]
    if restored % 1 ~= 0 then return nil end
    return restored
end
local function GetRngSeed() return math.random(1, 1000000) end

local function E1() return tonumber(#game:GetService("Workspace"):GetChildren()) end
local function E2() return tonumber(#game:GetChildren()) end
local function E3() return tonumber(#game:GetService("Players"):GetPlayers()) end
local function E4() return tonumber(Players.LocalPlayer.UserId) end
local function E5() return tonumber(game.PlaceId) end
local function E6()
    local s = (game.JobId or ""):gsub("-", "")
    return tonumber(s:sub(1, 15), 16) or 0
end

local function R1()
    local b = GetRngSeed() + GetRngSeed() + E1() + E2()
    local r1, r2 = math.random(1, 1000), math.random(1, 1000)
    return Equate(((r1 ~= 0) and (b * r1) or b) + r2 + (E1() % (r2 + 1)))
end
local function R2()
    local b = GetRngSeed() + GetRngSeed() + E3() + E4()
    local r3, r4 = math.random(1, 1000), math.random(1, 1000)
    local c = (r3 % 2 == 0) and (b + r3) or (b - (r3 % 256))
    return Equate(((r4 ~= 0) and (c * r4) or c) + E3())
end
local function R3()
    local b = GetRngSeed() + GetRngSeed() + E5() + E6()
    local r5, r6 = math.random(1, 1000), math.random(1, 1000)
    local sh = bit32.lshift(b % 2^20, (r5 % 8))
    return Equate(((r6 > 0) and (sh % (r6 + 1)) or sh) + r5 + E5())
end
local function R4()
    local b = GetRngSeed() + GetRngSeed() + E4() + E5()
    local r7, r8 = math.random(1, 1000), math.random(1, 1000)
    local x = bit32.bxor(b % 2^20, r7)
    return Equate(((r8 ~= 0) and (x * (r8 % 100)) or x) + E4() + r7)
end
local function R5()
    local b = GetRngSeed() + GetRngSeed() + E6() + E4()
    local r9, r10 = math.random(1, 1000), math.random(1, 1000)
    local m = (r10 > 0) and (b % r10) or b
    return Equate(((r9 ~= 0) and (m * r9) or m) + E6() + r10)
end

-- ═══ JSON (own decoder) ═══
-- Parsing the response with our own decoder means a hook on
-- HttpService:JSONDecode cannot rewrite a rejection into an approval.
local JsonDecode
do
    local escapes = { ["b"] = "\b", ["f"] = "\f", ["n"] = "\n", ["r"] = "\r", ["t"] = "\t", ['"'] = '"', ["\\"] = "\\", ["/"] = "/" }
    local function skip(text, index)
        while true do
            local ch = text:sub(index, index)
            if ch == " " or ch == "\t" or ch == "\n" or ch == "\r" then index = index + 1 else break end
        end
        return index
    end
    local parseValue
    local function parseString(text, index)
        local out = {}
        index = index + 1
        while true do
            local ch = text:sub(index, index)
            if ch == "" then error("unterminated string") end
            if ch == '"' then return table.concat(out), index + 1 end
            if ch == "\\" then
                local code = text:sub(index + 1, index + 1)
                if code == "u" then
                    local hex = text:sub(index + 2, index + 5)
                    local num = tonumber(hex, 16) or 63
                    out[#out + 1] = Char(num)
                    index = index + 6
                else
                    out[#out + 1] = escapes[code] or code
                    index = index + 2
                end
            else
                out[#out + 1] = ch
                index = index + 1
            end
        end
    end
    local function parseNumber(text, index)
        local raw = text:match("^-?%d+%.?%d*[eE]?[-+]?%d*", index)
        if not raw or raw == "" then error("bad number") end
        return tonumber(raw), index + #raw
    end
    local function parseTable(text, index)
        index = skip(text, index + 1)
        local result = {}
        if text:sub(index, index) == "]" then return result, index + 1 end
        local position = 1
        while true do
            local value
            value, index = parseValue(text, index)
            result[position] = value
            position = position + 1
            index = skip(text, index)
            local ch = text:sub(index, index)
            index = index + 1
            if ch == "]" then return result, index end
            if ch ~= "," then error("bad array") end
            index = skip(text, index)
        end
    end
    local function parseObject(text, index)
        index = skip(text, index + 1)
        local result = {}
        if text:sub(index, index) == "}" then return result, index + 1 end
        while true do
            local key
            key, index = parseString(text, index)
            index = skip(text, index)
            if text:sub(index, index) ~= ":" then error("bad object") end
            index = skip(text, index + 1)
            local value
            value, index = parseValue(text, index)
            result[key] = value
            index = skip(text, index)
            local ch = text:sub(index, index)
            index = index + 1
            if ch == "}" then return result, index end
            if ch ~= "," then error("bad object") end
            index = skip(text, index)
        end
    end
    parseValue = function(text, index)
        index = skip(text, index)
        local ch = text:sub(index, index)
        if ch == "{" then return parseObject(text, index) end
        if ch == "[" then return parseTable(text, index) end
        if ch == '"' then return parseString(text, index) end
        if ch == "t" then return true, index + 4 end
        if ch == "f" then return false, index + 5 end
        if ch == "n" then return nil, index + 4 end
        return parseNumber(text, index)
    end
    JsonDecode = function(text)
        if type(text) ~= "string" or #text == 0 then return nil end
        local ok, value = pcall(function() return (parseValue(text, 1)) end)
        if not ok then return nil end
        return value
    end
end

local function EncodeJson(value)
    local kind = type(value)
    if kind == "nil" then return "null" end
    if kind == "boolean" then return tostring(value) end
    if kind == "number" then
        -- tostring() truncates at 14 significant digits, which would round the
        -- challenge values (they run up to 1e14). Emit integers exactly.
        if value ~= value or value == math.huge or value == -math.huge then return "null" end
        if value % 1 == 0 and Abs(value) < 2 ^ 53 then return string.format("%.0f", value) end
        return string.format("%.17g", value)
    end
    if kind == "string" then
        return '"' .. value:gsub('[%z\1-\31\\"]', function(ch)
            local map = { ['"'] = '\\"', ["\\"] = "\\\\", ["\n"] = "\\n", ["\r"] = "\\r", ["\t"] = "\\t" }
            return map[ch] or string.format("\\u%04x", ch:byte())
        end) .. '"'
    end
    if kind == "table" then
        if #value > 0 then
            local parts = {}
            for index = 1, #value do parts[index] = EncodeJson(value[index]) end
            return "[" .. table.concat(parts, ",") .. "]"
        end
        local parts = {}
        for key, item in pairs(value) do
            parts[#parts + 1] = EncodeJson(tostring(key)) .. ":" .. EncodeJson(item)
        end
        return "{" .. table.concat(parts, ",") .. "}"
    end
    return "null"
end

-- ═══ POST ═══
local function postJSON(path, payload, hwid)
    -- Reuse the exact native device value from this login for every request.
    if type(hwid) ~= "string" or #hwid < 4 or #hwid > 512 then
        return nil, "Trusted executor device ID unavailable"
    end
    local headers = { ["Content-Type"] = "application/json", ["x-ms999-hwid"] = hwid }
    local ok, res = pcall(HttpRequest, {
        Url = BASE_URL .. path,
        Method = "POST",
        Headers = headers,
        Body = EncodeJson(payload),
    })
    if not ok or type(res) ~= "table" then return nil, "Connection failed" end
    local status = res.StatusCode or res.Status
    local responseBody = res.Body
    if type(status) ~= "number" or type(responseBody) ~= "string" then
        return nil, "Malformed response"
    end
    local decoded = JsonDecode(responseBody)
    if type(decoded) ~= "table" then return nil, "Invalid response" end
    return { status = status, data = decoded, body = responseBody }, nil
end

local function EncodeBody(tbl)
    local json = EncodeJson(tbl)
    local encrypted = Xor(json, XORKey)
    local b64 = Base64(encrypted)
    local full = XORKey .. b64
    local bytes = {}
    for i = 1, #full do table.insert(bytes, Byte(full, i)) end
    return { Data = bytes }
end

-- ═══ Load & Run ═══
local function LoadScript(d, h)
    if not ChecksActive then return end
    if not chainIs("payload", CHAIN_SESSION_TTL) then
        return KickPlayer("[999MS] Chain expired before script", 0)
    end
    if type(h) ~= "string" or #h < 4 or #h > 512 then
        return KickPlayer("Invalid device context", 0)
    end
    Chain.Stage = "script"
    Chain.Script = SCRIPT_NAME_LOCKED
    Chain.UpdatedAt = tick()

    local r = d.RuntimeSecret or ""
    local s = d.ScriptToken or ""
    local p = d.hop or ""
    local q = Ticket
    if type(r) ~= "string" or #r ~= 64 then
        return KickPlayer("Invalid runtime secret", 0)
    end
    if type(q) ~= "string" or q == ""
        or type(s) ~= "string" or s == ""
        or type(p) ~= "string" or p == "" then
        return KickPlayer("Invalid session context", 0)
    end

    ServerId = d.ServerId or ""

    if _G.MS999_UI then pcall(function() _G.MS999_UI:Destroy() end); _G.MS999_UI = nil end

    print("[999MS] Loading main script...")

    -- Every guarded stage above bumped Step. A hook that short-circuits one of
    -- them leaves the count short, so the hand-off refuses to run.
    if Step ~= STEP_TARGET then
        TamperKick("S9")
        return
    end

    local chunk = SafeLoadstring(d.Body)
    if not chunk then return KickPlayer("Load failed", 0) end
    local ok = pcall(chunk, true, q, s, r, p, SCRIPT_NAME_LOCKED, tick(), h, HttpRequest, Chain, ChainEnv)
    if not ok then return KickPlayer("Run failed", 0) end

    print("[999MS] Main script loaded")

    -- The requested lifecycle ends monitoring once the protected script has
    -- launched successfully. This also clears the session and stage-2 state.
    StopChecks()
end

local function FetchAndLoad(key, sname)
    if not ChecksActive then return nil, "Cancelled" end
    if not chainIs("payload", CHAIN_SESSION_TTL) then
        KickPlayer("[999MS] Chain expired", 0)
        return nil, "Chain expired"
    end
    local authScope = 0
    local hwid = GetHWID()
    if type(hwid) ~= "string" then
        return nil, "Trusted executor device ID unavailable"
    end
    local userId = tostring(Players.LocalPlayer.UserId)

    -- One attempt, one counter. It used to accumulate across attempts, so a
    -- failed auto-load with a stale cached key followed by a manual login left
    -- Step at 5 and the hand-off kicked with S9 even though the key passed.
    Step = 1

    -- Generate the challenge before the first call: the server transforms these
    -- values and we invert the transform to prove the response is genuine.
    local rng = {
        Rng1 = Floor(R1()), Rng2 = Floor(R2()), Rng3 = Floor(R3()),
        Rng4 = Floor(R4()), Rng5 = Floor(R5()),
        RngFloat = math.random(1, 1000000) + math.random(),
    }

    print("[999MS] Verifying key...")

    local r1, err = postJSON("/api/verify", {
        key = key, hwid = hwid, userId = userId, scriptName = sname,
        Rng1 = rng.Rng1, Rng2 = rng.Rng2, Rng3 = rng.Rng3,
        Rng4 = rng.Rng4, Rng5 = rng.Rng5, RngFloat = rng.RngFloat,
    }, hwid)

    if not r1 then return nil, err or "Connection failed" end
    if r1.status == 429 then return nil, "Rate limited" end
    if r1.status == 403 then return nil, r1.data.message or "Banned" end
    if r1.status ~= 200 or r1.data.valid ~= true then
        return nil, r1.data.message or r1.data.error or "Invalid key"
    end
    authScope = authScope + 1
    if not ChecksActive then return nil, "Cancelled" end

    Ticket = r1.data.ticket
    XORKey = r1.data.k or ""
    Step = Step + 1

    -- Invert the server-side transforms. A hooked or replayed response cannot
    -- carry the correct pair for values it never saw.
    if type(r1.data.check) == "string" then
        local parts = Split(r1.data.check, "|")
        if #parts ~= 5 then return nil, "Bad challenge" end
        for index = 1, 5 do
            local restored = RestoreChallenge(index, tonumber(parts[index]))
            if restored ~= ({ rng.Rng1, rng.Rng2, rng.Rng3, rng.Rng4, rng.Rng5 })[index] then
                Step = Step - 47
                return nil, "Challenge mismatch"
            end
        end
        Step = Step + 1
    else
        return nil, "Missing challenge"
    end

    -- Equation: A = 2x - 32 and B = 5x + 256 are two views of the same secret.
    local fromA = (tonumber(r1.data.A) + 32) / 2
    local fromB = (tonumber(r1.data.B) - 256) / 5
    if type(fromA) ~= "number" or fromA ~= fromB or fromA % 1 ~= 0 then
        return nil, "Equation mismatch"
    end
    local equationAnswer = Equate(fromA)

    print("[999MS] Key verified")

    local body = EncodeBody(rng)
    body.ticket = Ticket
    body.scriptName = sname
    body.hop = r1.data.hop
    body.eq = equationAnswer

    local r2, err2 = postJSON("/api/script", body, hwid)
    if not r2 then return nil, err2 or "Script fetch failed" end
    if r2.status ~= 200 then return nil, r2.body or "Script fetch failed" end
    if not ChecksActive then return nil, "Cancelled" end

    local resp = r2.data
    if not resp or not resp.Data then return nil, "Invalid response" end

    local okDec, decrypted = pcall(function()
        local raw = ""
        for _, b in ipairs(resp.Data) do raw = raw .. Char(b) end
        local b64 = raw:sub(#XORKey + 1)
        return JsonDecode(Xor(Base64Decode(b64), XORKey))
    end)

    if not okDec or type(decrypted) ~= "table" then return nil, "Decode failed" end
    if decrypted.Valid ~= true then return nil, decrypted.reason or "Server rejected" end
    authScope = authScope + 1

    if type(decrypted.check) ~= "string" then return nil, "RNG challenge missing" end
    local parts = Split(decrypted.check, "|")
    if #parts ~= 5 then return nil, "RNG challenge malformed" end

    local rngOriginals = { rng.Rng1, rng.Rng2, rng.Rng3, rng.Rng4, rng.Rng5 }
    for index = 1, 5 do
        local restored = RestoreChallenge(index, tonumber(parts[index]))
        if restored == nil or not SecureEQ(restored, rngOriginals[index]) then
            Step = Step - 47
            return nil, "RNG check failed"
        end
    end
    Step = Step + 1

    authScope = authScope + 1
    if authScope ~= 3 then return nil, "Authentication flow interrupted" end
    return decrypted, hwid
end

-- ═══ UI ═══
local function MakeUI()
    if _G.MS999_UI then pcall(function() _G.MS999_UI:Destroy() end) end

    local gui = Instance.new("ScreenGui")
    gui.Name = "999MSUI"
    gui.ResetOnSpawn = false
    gui.IgnoreGuiInset = true
    pcall(function() gui.Parent = game:GetService("CoreGui") end)
    if not gui.Parent then gui.Parent = Players.LocalPlayer:WaitForChild("PlayerGui") end
    _G.MS999_UI = gui

    local frame = Instance.new("Frame")
    frame.Size = UDim2.new(0, 340, 0, 300)
    frame.Position = UDim2.new(0.5, -170, 0.5, -150)
    frame.BackgroundColor3 = Color3.fromRGB(18, 18, 24)
    frame.BorderSizePixel = 0
    frame.Active = true
        frame.Draggable = true
    frame.Parent = gui

    local c1 = Instance.new("UICorner")
    c1.CornerRadius = UDim.new(0, 12)
    c1.Parent = frame

    local s1 = Instance.new("UIStroke")
    s1.Color = Color3.fromRGB(60, 60, 80)
    s1.Parent = frame

    local grad = Instance.new("Frame")
    grad.Size = UDim2.new(1, 0, 0, 4)
    grad.BackgroundColor3 = Color3.fromRGB(88, 101, 242)
    grad.BorderSizePixel = 0
    grad.Parent = frame

    local cg = Instance.new("UICorner")
    cg.CornerRadius = UDim.new(0, 12)
    cg.Parent = grad

    local title = Instance.new("TextLabel")
    title.Size = UDim2.new(1, -40, 0, 30)
    title.Position = UDim2.new(0, 20, 0, 15)
    title.BackgroundTransparency = 1
    title.Font = Enum.Font.GothamBold
    title.TextSize = 20
    title.Text = "999MS"
    title.TextColor3 = Color3.fromRGB(255, 255, 255)
    title.TextXAlignment = Enum.TextXAlignment.Left
    title.Parent = frame

    local close = Instance.new("TextButton")
    close.Size = UDim2.new(0, 26, 0, 26)
    close.Position = UDim2.new(1, -35, 0, 17)
    close.BackgroundColor3 = Color3.fromRGB(40, 40, 50)
    close.BorderSizePixel = 0
    close.Text = "x"
    close.Font = Enum.Font.GothamBold
    close.TextSize = 18
    close.TextColor3 = Color3.fromRGB(200, 200, 210)
    close.Parent = frame

    local cc = Instance.new("UICorner")
    cc.CornerRadius = UDim.new(0, 6)
    cc.Parent = close

    close.MouseButton1Click:Connect(function()
        gui:Destroy()
        _G.MS999_UI = nil
        StopChecks()
    end)

    local sub = Instance.new("TextLabel")
    sub.Size = UDim2.new(1, -40, 0, 18)
    sub.Position = UDim2.new(0, 20, 0, 48)
    sub.BackgroundTransparency = 1
    sub.Font = Enum.Font.Gotham
    sub.TextSize = 12
    sub.Text = "Enter your key to start"
    sub.TextColor3 = Color3.fromRGB(140, 140, 160)
    sub.TextXAlignment = Enum.TextXAlignment.Left
    sub.Parent = frame

    local boxHolder = Instance.new("Frame")
    boxHolder.Size = UDim2.new(1, -40, 0, 40)
    boxHolder.Position = UDim2.new(0, 20, 0, 75)
    boxHolder.BackgroundColor3 = Color3.fromRGB(28, 28, 36)
    boxHolder.BorderSizePixel = 0
    boxHolder.Parent = frame

    local bc = Instance.new("UICorner")
    bc.CornerRadius = UDim.new(0, 8)
    bc.Parent = boxHolder

    local bs = Instance.new("UIStroke")
    bs.Color = Color3.fromRGB(60, 60, 80)
    bs.Parent = boxHolder

    local input = Instance.new("TextBox")
    input.Size = UDim2.new(1, -20, 1, 0)
    input.Position = UDim2.new(0, 10, 0, 0)
    input.BackgroundTransparency = 1
    input.Font = Enum.Font.Code
    input.TextSize = 14
    input.Text = USER_KEY ~= "" and USER_KEY or ""
    input.PlaceholderText = "KEY_xxxxxxxxxxxxx"
    input.PlaceholderColor3 = Color3.fromRGB(90, 90, 110)
    input.TextColor3 = Color3.fromRGB(255, 255, 255)
    input.TextXAlignment = Enum.TextXAlignment.Left
    input.ClearTextOnFocus = false
    input.Parent = boxHolder

    local scriptLabel = Instance.new("TextLabel")
    scriptLabel.Size = UDim2.new(1, -40, 0, 14)
    scriptLabel.Position = UDim2.new(0, 20, 0, 122)
    scriptLabel.BackgroundTransparency = 1
    scriptLabel.Font = Enum.Font.Gotham
    scriptLabel.TextSize = 11
    scriptLabel.Text = "Script: " .. SCRIPT_NAME_LOCKED
    scriptLabel.TextColor3 = Color3.fromRGB(140, 140, 160)
    scriptLabel.TextXAlignment = Enum.TextXAlignment.Left
    scriptLabel.Parent = frame

    local status = Instance.new("TextLabel")
    status.Size = UDim2.new(1, -40, 0, 16)
    status.Position = UDim2.new(0, 20, 0, 145)
    status.BackgroundTransparency = 1
    status.Font = Enum.Font.Gotham
    status.TextSize = 11
    status.Text = ""
    status.TextColor3 = Color3.fromRGB(255, 100, 100)
    status.TextXAlignment = Enum.TextXAlignment.Left
    status.Parent = frame

    local btn = Instance.new("TextButton")
    btn.Size = UDim2.new(1, -40, 0, 40)
    btn.Position = UDim2.new(0, 20, 0, 170)
    btn.BackgroundColor3 = Color3.fromRGB(88, 101, 242)
    btn.BorderSizePixel = 0
    btn.Text = "Verify Key"
    btn.Font = Enum.Font.GothamBold
    btn.TextSize = 14
    btn.TextColor3 = Color3.fromRGB(255, 255, 255)
    btn.Parent = frame

    local bcc = Instance.new("UICorner")
    bcc.CornerRadius = UDim.new(0, 8)
    bcc.Parent = btn

    local buyBtn = Instance.new("TextButton")
    buyBtn.Size = UDim2.new(1, -40, 0, 34)
    buyBtn.Position = UDim2.new(0, 20, 0, 220)
    buyBtn.BackgroundColor3 = Color3.fromRGB(35, 35, 45)
    buyBtn.BorderSizePixel = 0
    buyBtn.Text = "Buy Key"
    buyBtn.Font = Enum.Font.GothamMedium
    buyBtn.TextSize = 13
    buyBtn.TextColor3 = Color3.fromRGB(200, 200, 220)
    buyBtn.Parent = frame

    local buc = Instance.new("UICorner")
    buc.CornerRadius = UDim.new(0, 8)
    buc.Parent = buyBtn

    local busy = false
    local function setStatus(msg, color)
        status.Text = type(msg) == "string" and msg or ""
        status.TextColor3 = color or Color3.fromRGB(255, 100, 100)
    end
    if E1 ~= "" then setStatus(E1) end
    local function setBusy(isBusy)
        busy = isBusy
        btn.Text = isBusy and "Checking..." or "Verify Key"
        btn.BackgroundColor3 = isBusy and Color3.fromRGB(60, 70, 160) or Color3.fromRGB(88, 101, 242)
        input.TextEditable = not isBusy
    end

    btn.MouseButton1Click:Connect(function()
        if busy then return end
        local key = input.Text
        if type(key) ~= "string" or key:match("^%s*$") then
            setStatus("Enter a key"); return
        end
        setBusy(true)
        setStatus("Verifying...", Color3.fromRGB(200, 200, 120))
        task.spawn(function()
            local decrypted, result = FetchAndLoad(key, SCRIPT_NAME_LOCKED)
            if not ChecksActive then return end
            if not decrypted then setStatus(result or "Error"); setBusy(false); return end
            setStatus("Success!", Color3.fromRGB(100, 255, 100))
            task.wait(0.3)
            if ChecksActive then LoadScript(decrypted, result) end
        end)
    end)

    buyBtn.MouseButton1Click:Connect(function()
        task.spawn(function()
            local hwid = GetHWID()
            if type(hwid) ~= "string" then
                setStatus("Trusted executor device ID unavailable")
                return
            end
            local r, err = postJSON("/api/start", { hwid = hwid }, hwid)
            if not ChecksActive then return end
            if not r then setStatus(err or "Cannot open link"); return end
            if r.status ~= 200 or not r.data.url then
                setStatus(r.data.error or "Cannot open link"); return
            end
            local url = r.data.url
            if SafeSetClipboard then
                pcall(SafeSetClipboard, url)
                setStatus("Link copied!", Color3.fromRGB(100, 200, 255))
            else
                setStatus("Link: " .. url:sub(1, 40), Color3.fromRGB(100, 200, 255))
            end
        end)
    end)
end

-- ===========================================================
-- MAIN
-- ===========================================================
if USER_KEY == "" then
    print("[999MS] No key, opening UI")
    MakeUI()
    return
end

task.spawn(function()
    local decrypted, result = FetchAndLoad(USER_KEY, SCRIPT_NAME_LOCKED)
    if not decrypted then
        E1 = result or "Invalid key"
        print("[999MS] Auto-load failed:", E1)
        MakeUI()
        return
    end
    LoadScript(decrypted, result)
end)
