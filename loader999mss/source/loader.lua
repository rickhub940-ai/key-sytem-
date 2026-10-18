-- ===========================================================
-- Stage 3: anti-checks, then the hand-off to Stage 4.
local gamaramam = {
    "@NEXT@"
}
-- ═══ BODY ═══ everything below is compacted at build time.
-- 999MS Bootstrap + Anti (Signal-based + T-RAWSET)
-- Anti-Save ตามไฟล์ X 100%
-- ===========================================================
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

local function patchErrorPrompt(code, diagnostic)
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
        local text = "Session terminated.\nReference: " .. code
        if type(diagnostic) == "string" and diagnostic ~= "" then
            text = text .. "\nDiagnostic: " .. diagnostic
        end
        label.Text = text
        return true
    end)
    return success and changed
end

local function Kick(reason, diagnostic)
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
            if patchErrorPrompt(code, diagnostic) then break end
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

local HttpService = game:GetService("HttpService")

local BASE_URL = "@BASE_URL@"
local CHAIN_VERSION = "999MS-chain-v1"
local CHAIN_TTL = 20

local G0 = getgenv
if type(G0) ~= "function" then return Kick("[999MS] getgenv unavailable") end
local E0 = G0()
if type(E0) ~= "table" then return Kick("[999MS] getgenv invalid") end
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

if not chainIs("stage2", CHAIN_TTL) then
    return Kick("[999MS] Chain rejected: run loadc.lua")
end

-- ═══ T0: require getgenv().script ═══
-- Default script name so a plain loadstring works without extra setup.
-- getgenv().script can still override it.
local userScript = E0.script or _G.script or "main"
if userScript == nil then
    return Kick(
        "[999MS] Set getgenv().script first:\n\n" ..
        'getgenv().script = "scriptname"\n' ..
        'loadstring(game:HttpGet("' .. BASE_URL .. '/loadc.lua"))()'
    )
end
if type(userScript) ~= "string" then
    return Kick("[999MS] getgenv().script must be string")
end
if #userScript < 1 or #userScript > 64 then
    return Kick("[999MS] getgenv().script must be 1-64 chars")
end
if not userScript:match("^[%w_%-]+$") then
    return Kick("[999MS] getgenv().script invalid format")
end

local SCRIPT_NAME = userScript
local SCRIPT_NAME_LOCKED = SCRIPT_NAME

print("[999MS] Bootstrap started")

-- ═══ Create Signal bus ═══
local function createSignal()
    local signal = {}
    local connections = {}
    local nextId = 0

    function signal:Connect(fn)
        if type(fn) ~= "function" then return { Disconnect = function() end } end
        nextId = nextId + 1
        local id = nextId
        connections[id] = fn
        return { Disconnect = function() connections[id] = nil end }
    end

    function signal:Fire(...)
        for _, fn in pairs(connections) do
            pcall(fn, ...)
        end
    end

    return signal
end

local MS999Signal = {
    OnDetect = createSignal(),
    OnKick = createSignal(),
    OnLog = createSignal(),
    OnHookDetected = createSignal(),
}
E0.MS999Signal = MS999Signal

-- ═══ Subscribers ═══
MS999Signal.OnKick:Connect(function(reason)
    local detail = "signal:" .. tostring(reason)
    print("[999MS] KICK:", makeKickCode(detail))
    pcall(function()
        Kick(detail)
    end)
    task.wait(0.3)
    if NfCrash then NfCrash() else while true do end end
end)

MS999Signal.OnLog:Connect(function(kind, data)
    local detail = tostring(kind) .. ":" .. tostring(data and data.path or data or "")
    print("[999MS][LOG]", makeKickCode(detail))
end)

MS999Signal.OnDetect:Connect(function(event)
    MS999Signal.OnLog:Fire("detect", event)
    if event.type == "payload_save" then
        MS999Signal.OnKick:Fire("Payload save detected: " .. tostring(event.path))
    end
end)

MS999Signal.OnHookDetected:Connect(function(event)
    MS999Signal.OnLog:Fire("hook_detected", event.name .. " - " .. event.reason)
    MS999Signal.OnKick:Fire("Hook detected: " .. event.name)
end)

-- ═══ Capture real functions ═══
local RealLoadstring = loadstring
-- Stage 2 owns the writefile hook. Its reference may be exposed through
-- E0 while the executor's global writefile alias is a different,
-- equivalent reference, so capture the Stage-2 monitor first.
local Stage2WriteMonitor = E0.MS999WriteMonitor
local RealWriteFile = type(Stage2WriteMonitor) == "function" and Stage2WriteMonitor
    or ((E0 and E0.writefile) or writefile)
local RealReadFile = readfile
local RealIsFile = isfile
local RealDelfile = delfile
local RealListFiles = listfiles
local RealGetGenv = function() return E0 end
local RealIsHooked = isfunctionhooked
local RealDebugGetInfo = debug.getinfo
local RealHookFunction = hookfunction
local RealNewCClosure = newcclosure
local RealRawset = rawset
local RealRawget = rawget

-- ═══ Helper ═══
local function checkFunction(fn, name)
    if type(fn) ~= "function" then return false, "missing" end
    local info = RealDebugGetInfo(fn)
    if not info or info.what ~= "C" then return false, "not C function" end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, fn)
        local trustedWriteMonitor = name == "writefile"
            and RealGetGenv().MS999WriteMonitor == fn
        if ok and hooked and not trustedWriteMonitor then return false, "hooked" end
    end
    if RealGetGenv()[name] and RealGetGenv()[name] ~= fn then
        return false, "getgenv replaced"
    end
    return true
end

local function guard(name, fn)
    local ok, reason = checkFunction(fn, name)
    if not ok then
        MS999Signal.OnHookDetected:Fire({ name = name, reason = reason })
    end
end

-- ═══ T2: Studio check ═══
if game:GetService("RunService"):IsStudio() then
    return Kick("[999MS] T2: Studio detected")
end

-- ═══ T3: pcall anti-hook ═══
do
    -- pcall(pcall) must fail when pcall is native; executor runtimes use
    -- different error wording, so validate the result rather than the text.
    local ok = pcall(pcall)
    if ok then
        return Kick("[999MS] T3: pcall hooked")
    end
end

-- ═══ T4: check important functions ═══
guard("loadstring", RealLoadstring)
guard("writefile", RealWriteFile)
guard("readfile", RealReadFile)
guard("isfile", RealIsFile)
guard("hookfunction", RealHookFunction)
guard("rawset", RealRawset)
guard("rawget", RealRawget)

-- ═══ T5: math.random behavior ═══
do
    if math.random(1, 2) == math.random(3, 4) then
        return Kick("[999MS] T5: math.random hooked")
    end
    local Same, Last = 0, 0
    for _ = 1, 100 do
        local Cur = math.random(1, 3569)
        if Cur == Last then Same = Same + 1 end
        Last = Cur
    end
    if Same > 10 then
        return Kick("[999MS] T5: math.random broken")
    end
end

-- ═══ T6: getgenv integrity ═══
do
    local test = {}
    E0.__MS999_test = test
    if E0.__MS999_test ~= test or getgenv ~= G0 then
        return Kick("[999MS] T6: getgenv tampered")
    end
    E0.__MS999_test = nil
end

-- ═══ T13: loadstring protection ═══
local SafeLoadstring = RealLoadstring
local SafeGetGenv = RealGetGenv

-- A loadstring hook installed before this loader starts can make a C-closure
-- check pass. Probe it with a temporary writefile interceptor: source-saving
-- wrappers (including the common `writefile(..., chunk)` pattern) will attempt
-- to write the probe and are rejected before the payload is fetched.
local function loadstringWritesSource()
    if type(SafeLoadstring) ~= "function" or type(RealWriteFile) ~= "function" then
        return false
    end

    local env = SafeGetGenv()
    if type(env) ~= "table" or env.writefile ~= RealWriteFile then
        return false
    end

    local originalWrite = env.writefile
    local wroteDuringProbe = false
    local interceptor = function(...)
        wroteDuringProbe = true
        -- Do not create the probe file. The wrapper only needs a successful
        -- return value to continue, then the loader can terminate safely.
        return true
    end

    local installed = pcall(function()
        env.writefile = interceptor
    end) and env.writefile == interceptor
    if not installed then
        pcall(function() env.writefile = originalWrite end)
        return false
    end

    local compiledOk, compiled = pcall(SafeLoadstring, "-- 999MS source-save probe\nreturn true")
    pcall(function() env.writefile = originalWrite end)

    -- Leave the existing T13 checks to report a broken loadstring implementation.
    if not compiledOk or type(compiled) ~= "function" then
        return false
    end
    return wroteDuringProbe
end

do
    if type(SafeLoadstring) ~= "function" then
        return Kick("[999MS] T13: loadstring missing")
    end
    local info = RealDebugGetInfo(SafeLoadstring)
    if not info or info.what ~= "C" then
        return Kick("[999MS] T13: loadstring wrapped")
    end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, SafeLoadstring)
        if ok and hooked then
            return Kick("[999MS] T13: loadstring hooked")
        end
    end
    if SafeGetGenv().loadstring ~= SafeLoadstring then
        return Kick("[999MS] T13: getgenv().loadstring replaced")
    end
    if loadstringWritesSource() then
        return Kick("[999MS] T13: loadstring attempted to save source")
    end
    local ok, fn = pcall(SafeLoadstring, "return 1 + 1")
    if not ok or type(fn) ~= "function" then
        return Kick("[999MS] T13: loadstring broken")
    end
    local ok2, result = pcall(fn)
    if not ok2 or result ~= 2 then
        return Kick("[999MS] T13: loadstring malfunction")
    end
end

-- ═══ T14: writefile protection ═══
do
    if type(RealWriteFile) == "function" then
        local info = RealDebugGetInfo(RealWriteFile)
        if not info or info.what ~= "C" then
            return Kick("[999MS] T14: writefile wrapped")
        end
        if type(RealIsHooked) == "function" then
            local ok, hooked = pcall(RealIsHooked, RealWriteFile)
            local trustedWriteMonitor = SafeGetGenv().MS999WriteMonitor == RealWriteFile
            if ok and hooked and not trustedWriteMonitor then
                return Kick("[999MS] T14: writefile hooked")
            end
        end
        if SafeGetGenv().writefile and SafeGetGenv().writefile ~= RealWriteFile then
            return Kick("[999MS] T14: writefile replaced")
        end
    end
end

-- ═══ T16: hookfunction protection ═══
do
    if type(RealHookFunction) == "function" then
        local info = RealDebugGetInfo(RealHookFunction)
        if not info or info.what ~= "C" then
            return Kick("[999MS] T16: hookfunction wrapped")
        end
        if type(RealIsHooked) == "function" then
            local ok, hooked = pcall(RealIsHooked, RealHookFunction)
            if ok and hooked then
                return Kick("[999MS] T16: hookfunction hooked")
            end
        end
    end
end

-- ═══ T-RAWSET1: rawset protection ═══
do
    if type(RealRawset) ~= "function" then
        return Kick("[999MS] T-RAWSET1: rawset missing")
    end
    local info = RealDebugGetInfo(RealRawset)
    if not info or info.what ~= "C" then
        return Kick("[999MS] T-RAWSET1: rawset wrapped")
    end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, RealRawset)
        if ok and hooked then
            return Kick("[999MS] T-RAWSET1: rawset hooked")
        end
    end
    local t = {}
    pcall(RealRawset, t, "test", 12345)
    if t.test ~= 12345 then
        return Kick("[999MS] T-RAWSET1: rawset broken")
    end
end

-- ═══ T-RAWSET2: rawget protection ═══
do
    if type(RealRawget) ~= "function" then
        return Kick("[999MS] T-RAWSET2: rawget missing")
    end
    local info = RealDebugGetInfo(RealRawget)
    if not info or info.what ~= "C" then
        return Kick("[999MS] T-RAWSET2: rawget wrapped")
    end
    if type(RealIsHooked) == "function" then
        local ok, hooked = pcall(RealIsHooked, RealRawget)
        if ok and hooked then
            return Kick("[999MS] T-RAWSET2: rawget hooked")
        end
    end
    local t = { test = 999 }
    if RealRawget(t, "test") ~= 999 then
        return Kick("[999MS] T-RAWSET2: rawget broken")
    end
end

-- ═══ T-RAWSET3: getgenv integrity ═══
local function checkGenvIntegrity()
    if E0.loadstring and E0.loadstring ~= RealLoadstring then
        return false, "loadstring changed"
    end
    if type(RealWriteFile) == "function" and E0.writefile
       and E0.writefile ~= RealWriteFile then
        return false, "writefile changed"
    end
    if type(RealHookFunction) == "function" and E0.hookfunction
       and E0.hookfunction ~= RealHookFunction then
        return false, "hookfunction changed"
    end
    if type(RealIsHooked) == "function" and E0.isfunctionhooked
       and E0.isfunctionhooked ~= RealIsHooked then
        return false, "isfunctionhooked changed"
    end
    if type(RealRawset) == "function" and E0.rawset
       and E0.rawset ~= RealRawset then
        return false, "rawset changed"
    end
    if type(RealRawget) == "function" and E0.rawget
       and E0.rawget ~= RealRawget then
        return false, "rawget changed"
    end
    return true
end

do
    local ok, reason = checkGenvIntegrity()
    if not ok then
        return Kick("[999MS] T-RAWSET3: " .. reason)
    end
end

-- ═══ T-HTTP: capture and audit the request implementation ═══
-- A C-closure result is only supplemental: newcclosure can make a wrapper look
-- native. Prefer the earliest request reference, reject detectable hooks, and
-- use that same captured reference for every later request.
local RealHttpRequest = nil
local RequestAudit = nil
do
    local candidates, seen = {}, {}
    local function addCandidate(label, fn)
        if type(fn) == "function" and not seen[fn] then
            seen[fn] = true
            table.insert(candidates, { label = label, fn = fn })
        end
    end

    local env = RealGetGenv()
    local envHttp = type(env.http) == "table" and env.http or nil
    local globalHttp = type(http) == "table" and http or nil
    addCandidate("getgenv.http.request", envHttp and envHttp.request)
    addCandidate("http.request", globalHttp and globalHttp.request)
    addCandidate("getgenv.request", env.request)
    addCandidate("request", request)
    addCandidate("getgenv.http_request", env.http_request)
    addCandidate("http_request", http_request)
    local envSyn = type(env.syn) == "table" and env.syn or nil
    local globalSyn = type(syn) == "table" and syn or nil
    addCandidate("getgenv.syn.request", envSyn and envSyn.request)
    addCandidate("syn.request", globalSyn and globalSyn.request)

    for _, candidate in ipairs(candidates) do
        local audit = { label = candidate.label, cClosure = nil, hookChecked = false }
        local usable = true
        if type(RealDebugGetInfo) == "function" then
            local ok, info = pcall(RealDebugGetInfo, candidate.fn)
            if ok and info then audit.cClosure = info.what == "C" end
        end
        if type(RealIsHooked) == "function" then
            local ok, hooked = pcall(RealIsHooked, candidate.fn)
            audit.hookChecked = ok
            if ok and hooked then usable = false end
        end
        if usable then
            RealHttpRequest, RequestAudit = candidate.fn, audit
            break
        end
    end

    if not RealHttpRequest then
        return Kick("[999MS] No trusted HTTP request")
    end
end

local HttpRequest = RealHttpRequest
E0.MS999Request = RealHttpRequest
E0.MS999RequestAudit = RequestAudit

-- ═══ Stage 3: Anti checks ═══
-- Stage 2 (savecheck.lua) completed its filesystem scan and installed the
-- trusted Signal.new write monitor.

-- ═══ สร้าง Loader Proof ═══
do
    local dynamicPart = ""
    for _ = 1, 32 do
        dynamicPart = dynamicPart .. string.char(math.random(97, 122))
    end
    E0.MS999LoaderProof = "999MS_loader_v1:" .. dynamicPart
    E0.MS999LoaderTime = tick()
    E0.MS999LoaderMarker = "LSE_" .. tostring(math.random(100000, 999999))
end

-- ═══ T-RAWSET4: 999MS flags integrity snapshot ═══
local MS999FlagSnapshot = {
    MS999Signal = E0.MS999Signal,
    MS999WriteMonitor = E0.MS999WriteMonitor,
    MS999Request = E0.MS999Request,
    MS999LoaderProof = E0.MS999LoaderProof,
    MS999LoaderMarker = E0.MS999LoaderMarker,
    MS999LoaderTime = E0.MS999LoaderTime,
}

local function checkMS999Flags()
    if E0.MS999Signal ~= MS999FlagSnapshot.MS999Signal then
        return false, "999MS signal replaced"
    end
    if E0.MS999WriteMonitor ~= MS999FlagSnapshot.MS999WriteMonitor
        or MS999FlagSnapshot.MS999WriteMonitor ~= RealWriteFile then
        return false, "write monitor replaced"
    end
    if E0.MS999Request ~= MS999FlagSnapshot.MS999Request
        or MS999FlagSnapshot.MS999Request ~= RealHttpRequest then
        return false, "request replaced"
    end
    if E0.MS999LoaderProof ~= MS999FlagSnapshot.MS999LoaderProof then
        return false, "999MS loader proof replaced"
    end
    if E0.MS999LoaderMarker ~= MS999FlagSnapshot.MS999LoaderMarker then
        return false, "999MS loader marker replaced"
    end
    if E0.MS999LoaderTime ~= MS999FlagSnapshot.MS999LoaderTime then
        return false, "999MS loader time replaced"
    end
    return true
end

do
    local ok, reason = checkMS999Flags()
    if not ok then
        return Kick("[999MS] T-RAWSET4: " .. reason)
    end
end

if not chainIs("stage2", 45) then
    return Kick("[999MS] Chain interrupted before payload")
end
Chain.Stage = "loader"
Chain.UpdatedAt = tick()

print("[999MS] Anti-checks passed")

-- ═══ โหลด payload ═══
print("[999MS] Fetching payload...")
-- Stage 4 link: minted by the server while serving this stage, held in the
-- header table so the marker and the hand-off live in one place.
local nextSha = "@NEXT_SHA@"
local nextNonce = "@NONCE@"
local nextUrl = gamaramam[1]
-- "NEXT@" without the leading "@" so this guard is never itself replaced.
if type(nextUrl) ~= "string" or #nextUrl < 40 or nextUrl:find("NEXT@", 1, true) then
    return Kick("[999MS] Stage link unavailable")
end

local cryptTable = E0.crypt or crypt
local hasher = type(cryptTable) == "table" and cryptTable.hash or nil
if type(hasher) ~= "function" then
    return Kick("[999MS] Payload hash unavailable")
end

-- The last link only opens for this stage's own proof, not for a plain fetch.
local okProof, proof = pcall(hasher, "999MS-fetch-v1|" .. nextNonce .. "|" .. nextUrl, "sha256")
if not okProof or type(proof) ~= "string" then
    return Kick("[999MS] Stage proof unavailable")
end

local ok, response = pcall(HttpRequest, {
    Url = nextUrl,
    Method = "POST",
    Headers = { ["content-type"] = "application/json" },
    Body = '{"p":"' .. proof .. '"}',
})
if not ok or type(response) ~= "table" or response.StatusCode ~= 200 then
    return Kick("[999MS] Payload fetch failed")
end

local payloadSrc = response.Body or ""
if #payloadSrc < 100 then
    return Kick("[999MS] Invalid payload")
end
local okHash, digest = pcall(hasher, payloadSrc, "sha256")
if not okHash or type(digest) ~= "string" or string.lower(digest) ~= nextSha then
    return Kick("[999MS] Payload integrity check failed")
end

print("[999MS] Payload received, running...")

local fn = SafeLoadstring(payloadSrc)
if not fn then return Kick("[999MS] Load failed") end
local runOk, runErr = pcall(fn)
if not runOk then
    -- Preserve the reference code and show a redacted short error so an
    -- executor-specific startup failure can be diagnosed without exposing keys.
    local detail = tostring(runErr):gsub("[%c]", " ")
    detail = detail:gsub("[%w_%-]+", function(token)
        return #token >= 16 and "[redacted]" or token
    end):sub(1, 120)
    pcall(function()
        if type(warn) == "function" then
            warn("[999MS] Payload startup error: " .. detail)
        else
            print("[999MS] Payload startup error: " .. detail)
        end
    end)
    return Kick("[999MS] Runtime error", detail)
end
