-- 999MS Stage 1. One freshly minted link per run, valid for 10 seconds.
if not game:IsLoaded() then game.Loaded:Wait() end

local LINK = "__STAGE2_TOKEN__"
local STAGE2_URL = "__BASE_URL__" .. "/loada.lua/" .. LINK
local STAGE2_SHA256 = "__STAGE2_SHA256__"

local env = (getgenv and getgenv()) or _G
env.MS999Chain = nil
env.MS999Chain = {
    Version = "999MS-chain-v1",
    Id = LINK:match("^(%x+)") or LINK,
    Stage = "stage1",
    UpdatedAt = tick(),
}

-- Stage 2 asks the server for its own Stage-3 link; give it this run's token.
env.MS999Link = LINK

local okGet, body = pcall(function() return game:HttpGet(STAGE2_URL) end)
if not okGet or type(body) ~= "string" or body == "" then
    env.MS999Chain = nil
    error("MS999:S1:E02:HTTP_GET_FAILED", 0)
end

local cryptTable = (env and env.crypt) or crypt
local hasher = type(cryptTable) == "table" and cryptTable.hash or nil
if type(hasher) ~= "function" then
    env.MS999Chain = nil
    error("MS999:S1:E04:LOADER_UNAVAILABLE", 0)
end

local okHash, digest = pcall(hasher, body, "sha256")
if not okHash or type(digest) ~= "string" or string.lower(digest) ~= STAGE2_SHA256 then
    env.MS999Chain = nil
    error("MS999:S1:E03:SHA256_MISMATCH", 0)
end

local loader = loadstring or load
if type(loader) ~= "function" then
    env.MS999Chain = nil
    error("MS999:S1:E04:LOADER_UNAVAILABLE", 0)
end

local okCompile, chunk = pcall(loader, body)
if not okCompile or type(chunk) ~= "function" then
    env.MS999Chain = nil
    error("MS999:S1:E05:STAGE2_COMPILE_FAILED", 0)
end

return chunk()
