-- Stage 2: remove dumped copies of this checker, then terminate.
--
-- Chain handover constant. The next hop is resolved from BASE_URL at run time;
-- the literal below is the only thing this stage needs from the hop table, so
-- everything after it can be protected/obfuscated as one block without touching
-- the handover.
local NEXT_LINK = "@BASE_URL@/x/6f2c9a84d1e07b35ac84f0d97c1e6b25a8d3f904"
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

local BASE_URL = "@BASE_URL@"
local CHAIN_VERSION = "999MS-chain-v1"
local CHAIN_TTL = 20

local env = getgenv()
local chain = env.MS999Chain
local chainId = type(chain) == "table" and chain.Id or nil
local function chainIs(stage, maxAge)
    local current = env.MS999Chain
    return current == chain
        and type(current) == "table"
        and current.Version == CHAIN_VERSION
        and type(current.Id) == "string"
        and current.Id == chainId
        and current.Stage == stage
        and type(current.UpdatedAt) == "number"
        and tick() - current.UpdatedAt >= 0
        and tick() - current.UpdatedAt <= maxAge
end

if not chainIs("stage1", CHAIN_TTL) then
    return Kick("[999MS] Chain rejected: run loadc.lua")
end

local RealListFiles = listfiles
local RealReadFile = readfile
local RealIsFile = isfile
local RealDelfile = delfile

local function removeMarkedFiles()
    if type(RealListFiles) ~= "function" or type(RealReadFile) ~= "function"
        or type(RealDelfile) ~= "function" then
        return false
    end

    -- Same literal that heads this stage, so a saved copy is traceable.
    local marker = NEXT_LINK
    local pending = { "." }
    local seen = {}
    local matches = {}

    while #pending > 0 do
        local folder = table.remove(pending)
        if not seen[folder] then
            seen[folder] = true
            local listed, entries = pcall(RealListFiles, folder)
            if listed and type(entries) == "table" then
                for _, entry in ipairs(entries) do
                    if not seen[entry] then
                        local fileCheck, isFile = false, false
                        if type(RealIsFile) == "function" then
                            fileCheck, isFile = pcall(RealIsFile, entry)
                        end

                        local readOk, content = false, nil
                        if not fileCheck or isFile then
                            readOk, content = pcall(RealReadFile, entry)
                            if readOk and type(content) == "string"
                                and content:find(marker, 1, true) then
                                table.insert(matches, entry)
                            end
                        end

                        if not isFile and not readOk then
                            table.insert(pending, entry)
                        end
                    end
                end
            end
        end
    end

    if #matches == 0 then return false end

    for _, path in ipairs(matches) do
        pcall(RealDelfile, path)
    end
    return true
end

if removeMarkedFiles() then
    return Kick("[999MS] Source save detected")
end

-- Use the same Signal.new + hookfunction write detector as X.lua for files
-- created after this stage has started.
if type(env.Signal) ~= "table" or type(env.Signal.new) ~= "function" then
    return Kick("[999MS] Signal.new unavailable")
end
if type(env.writefile) ~= "function" or type(hookfunction) ~= "function"
    or type(newcclosure) ~= "function" then
    return Kick("[999MS] Write monitor unavailable")
end

local saved = env.Signal.new()
local target = env.writefile
local oldWrite
local saveConnection

env.MS999ChecksActive = true

oldWrite = hookfunction(target, newcclosure(function(path, contents, ...)
    local result = table.pack(pcall(oldWrite, path, contents, ...))
    local success = result[1] and result[2] ~= false

    if success and env.MS999ChecksActive ~= false then
        saved:Fire({
            api = "writefile",
            path = tostring(path),
            bytes = typeof(contents) == "string" and #contents or nil,
        })
    end

    if not result[1] then
        error(result[2], 0)
    end
    return table.unpack(result, 2, result.n)
end))

saveConnection = saved:Connect(function(event)
    if env.MS999ChecksActive == false then return end

    if type(RealIsFile) == "function" and type(RealDelfile) == "function" then
        pcall(function()
            if RealIsFile(event.path) then
                RealDelfile(event.path)
            end
        end)
    end

    pcall(function()
        Kick("[999MS] Source save detected: " .. tostring(event.path))
    end)
    task.wait(0.3)
    if NfCrash then NfCrash() else while true do end end
end)

-- Called by the UI on close and after a successful main-script launch. The
-- hook itself cannot be safely removed across executors, so it is made inert
-- and its signal subscription is disconnected.
env.MS999StopChecks = function()
    env.MS999ChecksActive = false
    if saveConnection and type(saveConnection.Disconnect) == "function" then
        pcall(function() saveConnection:Disconnect() end)
    end
    env.MS999WriteMonitor = nil
    env.MS999StopChecks = nil
end

-- Stage 3 recognizes this stage-owned writefile hook as trusted.
env.MS999WriteMonitor = target

if not chainIs("stage1", 60) then
    return Kick("[999MS] Chain interrupted before Stage 3")
end
chain.Stage = "stage2"
chain.UpdatedAt = tick()

local requestFn = (syn and syn.request) or (http and http.request) or request or http_request
if type(requestFn) ~= "function" then
    return Kick("[999MS] HTTP not supported")
end

local ok, response = pcall(requestFn, {
    Url = BASE_URL .. "/loader.lua",
    Method = "GET",
})
if not ok or type(response) ~= "table" or response.StatusCode ~= 200 then
    return Kick("[999MS] Loader fetch failed")
end

local chunk = loadstring(response.Body or "")
if type(chunk) ~= "function" then
    return Kick("[999MS] Loader compile failed")
end

local runOk = pcall(chunk)
if not runOk then
    return Kick("[999MS] Loader runtime error")
end
