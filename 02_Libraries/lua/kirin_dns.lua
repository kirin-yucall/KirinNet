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
end

return kirin_dns
