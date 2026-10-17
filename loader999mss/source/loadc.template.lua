-- 999MS Stage 1 (readable). Builds the Stage-2 capability URL and verifies
-- the Stage-2 body with SHA-256 before it is compiled.
if not game:IsLoaded() then game.Loaded:Wait() end

local CHAIN_ID = "__CHAIN_ID__"
local CAP_D = "__CAP_D__"
local CAP_N = "__CAP_N__"
local STAGE2_SHA256 = "__STAGE2_SHA256__"
local BASE_URL = "__BASE_URL__"

local env = (getgenv and getgenv()) or _G
env.MS999Chain = nil
env.MS999Chain = {
    Version = "999MS-chain-v1",
    Id = CHAIN_ID,
    Stage = "stage1",
    UpdatedAt = tick(),
}

local url = BASE_URL .. "/loada.lua/" .. CAP_D .. "/" .. CAP_N

local okGet, body = pcall(function() return game:HttpGet(url) end)
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
