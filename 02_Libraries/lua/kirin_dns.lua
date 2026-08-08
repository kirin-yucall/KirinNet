-- =============================================================================
-- KirinDNS Resolution Protocol (ADRP) v2.0 -- Lua Client Library
--
-- Implements ADRP as defined in 01_Standard/spec_v1.md.
--
-- Architecture:
--   SRV records for service port discovery (_kirinnet-http._tcp, etc.)
--   TXT records for identity metadata (id=;key=;nick=;ipfs=)
--
-- Pure Lua 5.1+ with luasocket (UDP). No other dependencies.
--
-- Usage:
--   local kirin = require("kirin_dns")
--   local srv = kirin.resolveService("alice.kirinnet.org", "ws")
--   --> {target="alice.kirinnet.org", port=8082}
--   local id = kirin.resolveIdentity("alice.kirinnet.org")
--   --> {id="550e8400-...", key="04abc...", nick="Alice"}
-- =============================================================================

local kirin_dns = {}

-- ---------------------------------------------------------------------------
-- Constants (spec Section 2.2)
-- ---------------------------------------------------------------------------

local SRV_SERVICES = {
    http  = "_kirinnet-http._tcp",
    https = "_kirinnet-https._tcp",
    ws    = "_kirinnet-ws._tcp",
}

local FALLBACK_PORTS = {
    http  = 80,
    https = 443,
    ws    = 80,
    wss   = 443,
}

-- ---------------------------------------------------------------------------
-- DNS wire format helpers
-- ---------------------------------------------------------------------------

--- Build a DNS question section for a given domain and QTYPE.
local function buildQuestion(domain, qtype)
    local q = ""
    for label in domain:gmatch("[^%.]+") do
        q = q .. string.char(#label) .. label
    end
    q = q .. "\x00"                              -- null terminator
    q = q .. string.char(math.floor(qtype / 256), qtype % 256)  -- QTYPE
    q = q .. "\x00\x01"                          -- QCLASS=IN
    return q
end

--- Build a complete raw DNS query packet.
local function buildQuery(domain, qtype)
    qtype = qtype or 16  -- default TXT
    local id1, id2 = math.random(0, 0xFF), math.random(0, 0xFF)
    local query = string.char(
        id1, id2,                                -- ID
        0x01, 0x00,                              -- FLAGS: RD=1
        0x00, 0x01,                              -- QDCOUNT=1
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00      -- AN/NS/ARCOUNT=0
    )
    return query .. buildQuestion(domain, qtype)
end

--- Read a domain name from DNS wire format at pos.
--- Handles compression pointers (0xC0). Returns name, newPos.
local function readName(response, pos)
    local name = ""
    local jumped = false
    local origPos = pos
    local jumps = 0

    while true do
        if pos > #response then break end
        local len = string.byte(response, pos)
        if len == 0 then
            pos = pos + 1
            break
        end
        -- Compression pointer (top 2 bits set)
        if len & 0xC0 == 0xC0 then
            if not jumped then
                origPos = pos + 2
            end
            -- Read pointer offset (lower 14 bits)
            local offset = ((len & 0x3F) * 256) + string.byte(response, pos + 1)
            pos = offset + 1  -- +1 because DNS wire is 1-indexed in our string
            jumped = true
            jumps = jumps + 1
            if jumps > 10 then break end  -- prevent infinite loops
        else
            pos = pos + 1
            if #name > 0 then name = name .. "." end
            name = name .. response:sub(pos, pos + len - 1)
            pos = pos + len
        end
    end

    if jumped then
        return name, origPos
    else
        return name, pos
    end
end

--- Send a raw UDP DNS query and return the response bytes.
local function rawDnsQuery(domain, qtype, dnsServer)
    dnsServer = dnsServer or "8.8.8.8"
    qtype = qtype or 16

    local socket = require("socket")
    local udp = socket.udp()
    udp:settimeout(3)

    local query = buildQuery(domain, qtype)
    local ok, err = udp:sendto(query, dnsServer, 53)
    if not ok then
        udp:close()
        return nil
    end

    local response, err = udp:receive(4096)
    udp:close()

    if type(response) ~= "string" or #response < 12 then
        return nil
    end
    return response
end

--- Parse DNS response header: return qdcount, ancount (1-indexed positions).
local function parseHeader(response)
    if #response < 12 then return 0, 0 end
    local qdcount = string.byte(response, 5) * 256 + string.byte(response, 6)
    local ancount = string.byte(response, 7) * 256 + string.byte(response, 8)
    return qdcount, ancount
end

--- Skip the question section in a DNS response, return position after it.
local function skipQuestions(response, pos, qdcount)
    for _ = 1, qdcount do
        local _, newPos = readName(response, pos)
        pos = newPos + 4  -- QTYPE(2) + QCLASS(2)
    end
    return pos
end

-- ---------------------------------------------------------------------------
-- TXT response parsing
-- ---------------------------------------------------------------------------

--- Parse TXT answers from DNS response, starting at pos.
local function parseTxtAnswers(response, pos, ancount)
    local results = {}
    for _ = 1, ancount do
        if pos + 10 > #response then break end
        -- Skip NAME
        local _, newPos = readName(response, pos)
        pos = newPos
        if pos + 10 > #response then break end

        local rtype = string.byte(response, pos) * 256 + string.byte(response, pos + 1)
        pos = pos + 8  -- TYPE(2) + CLASS(2) + TTL(4)
        local rdlen = string.byte(response, pos) * 256 + string.byte(response, pos + 1)
        pos = pos + 2

        if rtype == 16 and rdlen > 1 then  -- TXT
            local txtlen = string.byte(response, pos)
            pos = pos + 1
            local txt = response:sub(pos, pos + math.min(txtlen, rdlen - 1) - 1)
            pos = pos + (rdlen - 1)
            table.insert(results, txt)
        else
            pos = pos + rdlen
        end
    end
    return results
end

-- ---------------------------------------------------------------------------
-- SRV response parsing
-- ---------------------------------------------------------------------------

--- Parse SRV answers from DNS response, starting at pos.
--- Returns list of {priority=int, weight=int, port=int, target=string}
local function parseSrvAnswers(response, pos, ancount)
    local results = {}
    for _ = 1, ancount do
        if pos + 10 > #response then break end
        -- Skip NAME
        local _, newPos = readName(response, pos)
        pos = newPos
        if pos + 10 > #response then break end

        local rtype = string.byte(response, pos) * 256 + string.byte(response, pos + 1)
        pos = pos + 8  -- TYPE(2) + CLASS(2) + TTL(4)
        local rdlen = string.byte(response, pos) * 256 + string.byte(response, pos + 1)
        pos = pos + 2

        if rtype == 33 and rdlen >= 6 then  -- SRV, min RDATA is 6 bytes
            local rdataStart = pos
            local priority = string.byte(response, pos) * 256 + string.byte(response, pos + 1)
            local weight   = string.byte(response, pos + 2) * 256 + string.byte(response, pos + 3)
            local port     = string.byte(response, pos + 4) * 256 + string.byte(response, pos + 5)
            local target, afterTarget = readName(response, pos + 6)
            pos = rdataStart + rdlen
            table.insert(results, {
                priority = priority,
                weight   = weight,
                port     = port,
                target   = target,
            })
        else
            pos = pos + rdlen
        end
    end
    return results
end

-- ---------------------------------------------------------------------------
--- Generic: parse DNS response and extract answers of a given type.
-- ---------------------------------------------------------------------------
local function parseDnsResponse(response)
    local qdcount, ancount = parseHeader(response)
    if ancount < 1 then return {} end

    local pos = skipQuestions(response, 13, qdcount)  -- 13 = 1-indexed after 12-byte header

    -- Peek at first answer type to decide parser
    if pos + 10 > #response then return {} end
    local _, afterName = readName(response, pos)
    local peekPos = afterName
    if peekPos + 2 > #response then return {} end
    local rtype = string.byte(response, peekPos) * 256 + string.byte(response, peekPos + 1)

    if rtype == 33 then
        return parseSrvAnswers(response, pos, ancount)
    else
        return parseTxtAnswers(response, pos, ancount)
    end
end

-- ---------------------------------------------------------------------------
-- Service Resolution (SRV)
-- ---------------------------------------------------------------------------

--- Resolve a single service port via SRV.
--- Returns {target=string, port=int} or nil if no SRV record found.
function kirin_dns.resolveService(domain, service)
    local srvName = SRV_SERVICES[service]
    if not srvName then
        error("Unknown service: " .. tostring(service) .. ". Recognized: http, https, ws")
    end

    local fullName = srvName .. "." .. domain
    local ok, response = pcall(rawDnsQuery, fullName, 33)
    if not ok or not response then
        return nil
    end

    local records = parseDnsResponse(response)
    if #records == 0 then
        return nil
    end

    -- RFC 2782: sort by priority asc, then weight desc
    table.sort(records, function(a, b)
        if a.priority ~= b.priority then return a.priority < b.priority end
        return a.weight > b.weight
    end)

    local best = records[1]
    return { target = best.target, port = best.port }
end

--- Resolve all SRV services for a domain.
--- Returns {http={target,port}|nil, https=..., ws=...}
function kirin_dns.resolveAllServices(domain)
    local result = {}
    for svc, _ in pairs(SRV_SERVICES) do
        result[svc] = kirin_dns.resolveService(domain, svc)
    end
    return result
end

-- ---------------------------------------------------------------------------
-- Identity Resolution (TXT)
-- ---------------------------------------------------------------------------

--- Parse a semicolon-separated key=value TXT string into an identity table.
--- Format: id=<uuid>;key=<hex>;nick=<name>;ipfs=<bool>
--- Returns nil if not a valid identity record.
function kirin_dns.parseIdentityTxt(txt)
    if type(txt) ~= "string" then return nil end
    txt = txt:match("^%s*(.-)%s*$")  -- trim
    if #txt == 0 or not txt:match("^id=") then
        return nil
    end

    local result = {}
    for pair in txt:gmatch("[^;]+") do
        local eq = pair:find("=")
        if eq then
            local key = pair:sub(1, eq - 1):match("^%s*(.-)%s*$")
            local val = pair:sub(eq + 1):match("^%s*(.-)%s*$")
            result[key] = val
        end
    end

    -- Both id and key are required
    if not result.id or not result.key then
        return nil
    end

    -- Parse ipfs boolean
    if result.ipfs ~= nil then
        result.ipfs = (result.ipfs == "true")
    end

    return result
end

--- Resolve identity metadata from TXT record.
--- Returns {id=string, key=string, nick?=string, ipfs?=bool} or nil.
function kirin_dns.resolveIdentity(domain)
    local ok, response = pcall(rawDnsQuery, domain, 16)
    if not ok or not response then
        return nil
    end

    local txts = parseDnsResponse(response)
    for _, txt in ipairs(txts) do
        local identity = kirin_dns.parseIdentityTxt(txt)
        if identity then
            return identity
        end
    end

    return nil
end

-- ---------------------------------------------------------------------------
-- did:dns three-record identity model (spec §3.2.1 / did-dns-protocol §2)
-- ---------------------------------------------------------------------------
--
-- Tamper-evident fingerprint chain: fp == Base64URL(SHA-256(pk)[0:12]).
-- Pure Lua (no bit library / no C crypto): SHA-256 is implemented with the
-- float-arithmetic trick (works on Lua 5.1/5.2/5.3/LuaJIT).

local DID_DNS_PREFIX       = "did:dns:"
local DID_DNS_DECL_PREFIX  = "did:dns:v="
local DID_DNS_PK_PREFIX    = "did:dns:pk;"
local DID_DNS_BLACK_PREFIX = "did:dns:black;"
local DID_DNS_KTY_ED25519  = "ed25519"
local DID_DNS_FP_BYTES     = 12   -- -> 16 base64url chars

-- ---- Base64URL (RFC 4648 §5, no padding) ----
local B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
local _b64rev = {}
for i = 1, #B64URL_ALPHABET do _b64rev[B64URL_ALPHABET:byte(i)] = i - 1 end

local function base64urlEncode(bytes)  -- bytes: array of int 0..255
    local out = {}
    local i = 1
    while i <= #bytes do
        -- collect up to 3 bytes -> 24 bits -> 4 base64 chars
        local b1 = bytes[i] or 0
        local b2 = bytes[i + 1]
        local b3 = bytes[i + 2]
        local c1 = math.floor(b1 / 4)                       -- bits 7..2 of b1
        local c2 = (b1 % 4) * 16                            -- bits 1..0 of b1
        local c3, c4 = 0, 0
        if b2 then
            c2 = c2 + math.floor(b2 / 16)                   -- bits 7..4 of b2
            c3 = (b2 % 16) * 4                              -- bits 3..0 of b2
            if b3 then
                c3 = c3 + math.floor(b3 / 64)               -- bits 7..6 of b3
                c4 = b3 % 64                                -- bits 5..0 of b3
            end
        end
        out[#out + 1] = B64URL_ALPHABET:sub(c1 + 1, c1 + 1)
        out[#out + 1] = B64URL_ALPHABET:sub(c2 + 1, c2 + 1)
        if b2 then out[#out + 1] = B64URL_ALPHABET:sub(c3 + 1, c3 + 1) end
        if b3 then out[#out + 1] = B64URL_ALPHABET:sub(c4 + 1, c4 + 1) end
        i = i + 3
    end
    return table.concat(out)
end

local function base64urlDecode(str)    -- returns array of int 0..255, or nil
    local out, val, valb = {}, 0, -8
    for i = 1, #str do
        local ch = str:byte(i)
        if ch ~= 0x3d then -- '='
            local d = _b64rev[ch]
            if not d then return nil end
            val = (val * 64 + d) % 262144
            valb = valb + 6
            if valb >= 0 then
                out[#out + 1] = math.floor(val / 2^valb) % 256
                valb = valb - 8
            end
        end
    end
    return out
end

-- ---- SHA-256 (FIPS 180-4), pure-Lua float arithmetic ----
local SHA256_K = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,
    0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
    0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,
    0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,
    0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,
    0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,
    0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,
    0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,
    0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
}

-- 32-bit ops via modulo (handles values up to ~2^53 safely)
local M32 = 0x100000000
local function add32(...) local s = 0; for _, v in ipairs({...}) do s = s + v end; return s % M32 end
local function band(a, b)
    local r, p = 0, 1
    for i = 0, 31 do
        local ba, bb = math.floor(a / 2^i) % 2, math.floor(b / 2^i) % 2
        if ba == 1 and bb == 1 then r = r + p end
        p = p * 2
    end
    return r
end
local function bxor(a, b)
    local r, p = 0, 1
    for i = 0, 31 do
        local ba, bb = math.floor(a / 2^i) % 2, math.floor(b / 2^i) % 2
        if ba ~= bb then r = r + p end
        p = p * 2
    end
    return r
end
local function bnot(a) return M32 - 1 - (a % M32) end
local function rshift(a, n) return math.floor((a % M32) / 2^n) end
local function rotr(a, n) return add32(rshift(a, n), (a % M32) * 2^(32 - n) % M32) end

local function sha256(bytes)
    local h = { 0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
                0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19 }
    local msg = {unpack(bytes)}
    local bitlen = #bytes * 8
    msg[#msg + 1] = 0x80
    while #msg % 64 ~= 56 do msg[#msg + 1] = 0 end
    for i = 7, 0, -1 do msg[#msg + 1] = math.floor(bitlen / 2^(i*8)) % 256 end

    for off = 1, #msg, 64 do
        -- schedule: w[1..16] from block, w[17..64] extended (1-indexed)
        local w = {}
        for i = 0, 15 do
            w[i + 1] = (msg[off + i*4]     * 0x1000000 +
                        msg[off + i*4 + 1] * 0x10000 +
                        msg[off + i*4 + 2] * 0x100 +
                        msg[off + i*4 + 3]) % M32
        end
        for i = 17, 64 do
            local s0 = bxor(bxor(rotr(w[i - 15], 7), rotr(w[i - 15], 18)), rshift(w[i - 15], 3))
            local s1 = bxor(bxor(rotr(w[i - 2], 17), rotr(w[i - 2], 19)), rshift(w[i - 2], 10))
            w[i] = add32(w[i - 16], s0, w[i - 7], s1)
        end
        local a,b,c,d,e,f,g,hh = h[1],h[2],h[3],h[4],h[5],h[6],h[7],h[8]
        for i = 1, 64 do
            local S1 = bxor(bxor(rotr(e, 6), rotr(e, 11)), rotr(e, 25))
            local ch = bxor(band(e, f), band(bnot(e), g))
            local t1 = add32(hh, S1, ch, SHA256_K[i], w[i])
            local S0 = bxor(bxor(rotr(a, 2), rotr(a, 13)), rotr(a, 22))
            local maj = bxor(bxor(band(a, b), band(a, c)), band(b, c))
            local t2 = add32(S0, maj)
            hh=g; g=f; f=e; e=add32(d, t1); d=c; c=b; b=a; a=add32(t1, t2)
        end
        h[1]=add32(h[1],a); h[2]=add32(h[2],b); h[3]=add32(h[3],c); h[4]=add32(h[4],d)
        h[5]=add32(h[5],e); h[6]=add32(h[6],f); h[7]=add32(h[7],g); h[8]=add32(h[8],hh)
    end
    local out = {}
    for i = 1, 8 do
        out[#out + 1] = rshift(h[i], 24) % 256
        out[#out + 1] = rshift(h[i], 16) % 256
        out[#out + 1] = rshift(h[i], 8) % 256
        out[#out + 1] = h[i] % 256
    end
    return out
end

local function parseDidDnsKv(segment)
    local out = {}
    for pair in segment:gmatch("[^;]+") do
        local eq = pair:find("=")
        if eq then
            local k = pair:sub(1, eq - 1):match("^%s*(.-)%s*$")
            local v = pair:sub(eq + 1):match("^%s*(.-)%s*$")
            out[k] = v
        end
    end
    return out
end

--- Create a DidDnsIdentity table.
local function newDidDnsIdentity()
    return {
        version = 1,
        fingerprint = "",
        nickname = "",        -- Base64URL(UTF-8)
        gender = "",          -- M/F/O/X
        issued_at = 0,
        expires_at = 0,
        key_type = DID_DNS_KTY_ED25519,
        public_key_b64url = "",
        blacklist = {},
    }
end

--- Recompute fp = Base64URL(SHA-256(pk)[0:12]). Empty string on malformed pk.
function kirin_dns.computeFingerprint(id)
    local pk = base64urlDecode(id.public_key_b64url)
    if not pk or #pk == 0 then return "" end
    local digest = sha256(pk)
    local first12 = {}
    for i = 1, DID_DNS_FP_BYTES do first12[i] = digest[i] end
    return base64urlEncode(first12)
end

--- True iff declared fp matches recomputed fp over the pk bytes.
function kirin_dns.fingerprintChainOk(id)
    return id.fingerprint ~= "" and id.fingerprint == kirin_dns.computeFingerprint(id)
end

function kirin_dns.isRevoked(id)
    for _, f in ipairs(id.blacklist) do if f == id.fingerprint then return true end end
    return false
end

function kirin_dns.isExpired(id, now)
    return id.expires_at ~= 0 and now >= id.expires_at
end

--- Composite policy: v1 + ed25519 + chain + not revoked + not expired.
function kirin_dns.isValid(id, now)
    return id.version == 1
        and id.key_type == DID_DNS_KTY_ED25519
        and kirin_dns.fingerprintChainOk(id)
        and not kirin_dns.isRevoked(id)
        and not kirin_dns.isExpired(id, now)
end

--- Classify TXT records by did:dns: sub-type; assemble an identity.
--- Returns an identity table, or nil if no did:dns records / decl+pk missing.
function kirin_dns.parseDidDnsIdentity(txtRecords)
    if type(txtRecords) ~= "table" then return nil end
    local declRaw, pkRaw, blackRaw
    for _, raw in ipairs(txtRecords) do
        local s = tostring(raw):match("^%s*(.-)%s*$")
        if not declRaw and s:sub(1, #DID_DNS_DECL_PREFIX) == DID_DNS_DECL_PREFIX then
            declRaw = s
        elseif not pkRaw and s:sub(1, #DID_DNS_PK_PREFIX) == DID_DNS_PK_PREFIX then
            pkRaw = s
        elseif not blackRaw and s:sub(1, #DID_DNS_BLACK_PREFIX) == DID_DNS_BLACK_PREFIX then
            blackRaw = s
        end
    end
    if not declRaw or not pkRaw then return nil end

    local decl = parseDidDnsKv(declRaw:sub(#DID_DNS_PREFIX + 1))
    local pk   = parseDidDnsKv(pkRaw:sub(#DID_DNS_PREFIX + 1))

    local id = newDidDnsIdentity()
    id.version          = tonumber(decl.v or "1") or 1
    id.fingerprint      = decl.fp or ""
    id.nickname         = decl.n or ""
    id.gender           = decl.g or ""
    id.issued_at        = tonumber(decl.iat or "0") or 0
    id.expires_at       = tonumber(decl.exp or "0") or 0
    id.key_type         = pk.kty or DID_DNS_KTY_ED25519
    id.public_key_b64url = pk.pk or ""

    if blackRaw then
        local bkv = parseDidDnsKv(blackRaw:sub(#DID_DNS_PREFIX + 1))
        local fpField = bkv.fp or ""
        for fp in fpField:gmatch("[^,]+") do
            if fp ~= "" then id.blacklist[#id.blacklist + 1] = fp end
        end
    end
    return id
end

-- ---------------------------------------------------------------------------
-- Legacy Compatibility Wrapper
-- ---------------------------------------------------------------------------

--- Full resolution: SRV + TXT + identity (legacy wrapper).
--- New code should use resolveService() and resolveIdentity() directly.
function kirin_dns.resolve_kirin_dns(domain)
    local ws = kirin_dns.resolveService(domain, "ws")
    return {
        domain   = domain,
        ws       = ws or { target = domain, port = FALLBACK_PORTS.ws },
        http     = kirin_dns.resolveService(domain, "http"),
        https    = kirin_dns.resolveService(domain, "https"),
        identity = kirin_dns.resolveIdentity(domain),
    }
end

-- ---------------------------------------------------------------------------
-- Exports
-- ---------------------------------------------------------------------------

kirin_dns.SRV_SERVICES   = SRV_SERVICES
kirin_dns.FALLBACK_PORTS = FALLBACK_PORTS

-- ---------------------------------------------------------------------------
-- Self-test (run: lua kirin_dns.lua)
-- ---------------------------------------------------------------------------
if arg and arg[0] and arg[0]:match("kirin_dns") then
    -- SRV nonexistent domain
    local ws = kirin_dns.resolveService("nonexistent.invalid", "ws")
    assert(ws == nil, "no SRV for nonexistent domain")

    -- TXT identity nonexistent domain
    local id = kirin_dns.resolveIdentity("nonexistent.invalid")
    assert(id == nil, "no TXT identity for nonexistent domain")

    -- Identity parser
    local parsed = kirin_dns.parseIdentityTxt(
        "id=550e8400-e29b-41d4-a716-446655440000;key=04abc;nick=Alice;ipfs=false"
    )
    assert(parsed.id == "550e8400-e29b-41d4-a716-446655440000", "id parsed")
    assert(parsed.key == "04abc", "key parsed")
    assert(parsed.nick == "Alice", "nick parsed")
    assert(parsed.ipfs == false, "ipfs parsed as bool")

    local minimal = kirin_dns.parseIdentityTxt("id=test-id;key=0x00")
    assert(minimal.id == "test-id", "minimal id")
    assert(minimal.key == "0x00", "minimal key")
    assert(minimal.nick == nil, "no nick")

    -- Invalid TXT
    assert(kirin_dns.parseIdentityTxt("v=spf1 include:_spf.example.com") == nil, "spf skipped")
    assert(kirin_dns.parseIdentityTxt("") == nil, "empty string")
    assert(kirin_dns.parseIdentityTxt("not an identity") == nil, "not identity")

    -- Legacy wrapper
    local full = kirin_dns.resolve_kirin_dns("nonexistent.invalid")
    assert(full.ws.port == 80, "legacy ws fallback")
    assert(full.http == nil, "legacy http nil")
    assert(full.identity == nil, "legacy identity nil")

    print("KirinDNS Lua self-test: PASSED")

    -- ---- did:dns three-record identity model (C-1 baseline) ----
    -- Deterministic 32-byte key = bytes 0..31 (matches the golden vector).
    local pkBytes = {}
    for i = 0, 31 do pkBytes[i + 1] = i end
    local pkB64 = base64urlEncode(pkBytes)
    local dg = sha256(pkBytes)
    local first12 = {}
    for i = 1, DID_DNS_FP_BYTES do first12[i] = dg[i] end
    local fpCalc = base64urlEncode(first12)
    local now = 1700000000

    local recs = {
        "v=spf1 include:_spf.kirinnet.org -all",
        "did:dns:v=1;fp="..fpCalc..";n=QWxpY2U;g=F;iat="..now..";exp="..(now + 3600),
        "did:dns:pk;kty=ed25519;pk="..pkB64,
        "did:dns:black;fp=RevokedAaaa,RevokedBbbb",
    }
    local did = kirin_dns.parseDidDnsIdentity(recs)
    assert(did ~= nil, "did:dns identity parsed")
    assert(did.version == 1, "did:dns version")
    assert(did.fingerprint == fpCalc, "did:dns fp")
    assert(did.key_type == "ed25519", "did:dns kty")
    assert(kirin_dns.fingerprintChainOk(did), "did:dns fingerprint chain")
    assert(kirin_dns.isValid(did, now), "did:dns valid")

    -- Tampered pk -> chain breaks
    local wrong = {}
    for i = 1, 32 do wrong[i] = 0xff end
    local wrongB64 = base64urlEncode(wrong)
    local tampered = { recs[1], recs[2], "did:dns:pk;kty=ed25519;pk="..wrongB64 }
    local broken = kirin_dns.parseDidDnsIdentity(tampered)
    assert(broken ~= nil and not kirin_dns.fingerprintChainOk(broken), "tampered pk breaks chain")

    -- Missing pk -> nil
    assert(kirin_dns.parseDidDnsIdentity({recs[2]}) == nil, "missing pk -> nil")
    -- No did:dns -> nil (legacy id= ignored)
    assert(kirin_dns.parseDidDnsIdentity({"v=spf1 -all", "id=foo;key=bar"}) == nil, "no did:dns -> nil")
    -- Wrong kty -> invalid
    local rsaId = kirin_dns.parseDidDnsIdentity({recs[2], "did:dns:pk;kty=rsa;pk="..pkB64})
    assert(rsaId.key_type == "rsa" and not kirin_dns.isValid(rsaId, now), "rsa kty rejected")

    print("KirinDNS Lua did:dns self-test: PASSED (fingerprint chain)")
end

return kirin_dns
