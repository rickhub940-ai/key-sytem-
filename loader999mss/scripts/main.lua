


local Players = game:GetService("Players")
local CoreGui = game:GetService("CoreGui")
local LocalPlayer = Players.LocalPlayer



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



    pcall(function()
        if type(replicatesignal) == "function" and LocalPlayer.StatsAvailable then
            replicatesignal(LocalPlayer.StatsAvailable, "Kick")
        end
    end)
    return LocalPlayer:Kick(code)
end

local HttpService = game:GetService("HttpService")
local ExpectedScript = "${SCRIPTID}"
local CHAIN_VERSION = "999MS-chain-v1"
local A, B, C, D, E, F, G, H, I, J, K = ...

if A ~= true then return Kick("[999MS] Must run via loader") end
local ChainEnv = K
local Chain = J
if type(ChainEnv) ~= "table"
    or type(Chain) ~= "table"
    or ChainEnv.MS999Chain ~= Chain
    or Chain.Version ~= CHAIN_VERSION
    or type(Chain.Id) ~= "string"
    or Chain.Stage ~= "script"
    or Chain.Script ~= ExpectedScript
    or type(Chain.UpdatedAt) ~= "number"
    or tick() - Chain.UpdatedAt < 0
    or tick() - Chain.UpdatedAt > 20 then
    return Kick("[999MS] Chain rejected: run loadc.lua")
end

local RuntimeSecret = D
local Ticket = B
local ScriptToken = C
local MS999Script = F
local LoadTime = G

if type(RuntimeSecret) ~= "string" or #RuntimeSecret ~= 64 then
    return Kick("[999MS] Missing runtime secret")
end
if type(Ticket) ~= "string" or Ticket == ""
    or type(ScriptToken) ~= "string" or ScriptToken == "" then
    return Kick("[999MS] Invalid session")
end
if MS999Script ~= ExpectedScript then
    return Kick("[999MS] Script mismatch")
end

if type(LoadTime) ~= "number" or tick() - LoadTime < 0 or (tick() - LoadTime) > 60 then
    return Kick("[999MS] Session expired")
end

local HWID = H
if type(HWID) ~= "string" or #HWID < 4 or #HWID > 512 then
    return Kick("[999MS] Device context invalid")
end

local req = I
if type(req) ~= "function" then return Kick("[999MS] HTTP not supported") end
local BASE_URL = "https://loader999mss.vercel.app"

local ok, res = pcall(req, {
    Url = BASE_URL .. "/api/script-verify",
    Method = "POST",
    Headers = { ["Content-Type"] = "application/json", ["x-ms999-hwid"] = HWID },
    Body = HttpService:JSONEncode({
        ticket = Ticket,
        hwid = HWID,
        scriptToken = ScriptToken,
        runtimeSecret = RuntimeSecret,
        scriptName = ExpectedScript,
        hop = E or "",
    }),
})

if not ok or type(res) ~= "table" then
    return Kick("[999MS] Verification failed")
end

local decoded
pcall(function() decoded = HttpService:JSONDecode(res.Body) end)
if not decoded or decoded.valid ~= true then



    local diagnostic = decoded and decoded.diagnostic
    if type(diagnostic) ~= "string" or not diagnostic:match("^D2_[A-Z0-9_]+$") then
        diagnostic = "D2_RESPONSE_INVALID"
    end
    return Kick("[999MS] " .. diagnostic)
end
if ChainEnv.MS999Chain == Chain then
    ChainEnv.MS999Chain = nil
end
