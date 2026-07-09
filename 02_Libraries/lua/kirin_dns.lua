-- =============================================================================
-- KirinDNS Resolution Protocol (ADRP) — Lua Client
--
-- Resolves service port mappings from DNS TXT records.
-- Pure Lua 5.1+ — no external dependencies.
--
-- Usage:
--   local kirin = require("kirin_dns")
--   local ports = kirin.resolve("alice.kirinnet.org")
--   print("HTTP: " .. ports.http)
-- =============================================================================

local kirin_dns = {}

local DEFAULT_HTTP  = 80
local DEFAULT_HTTPS = 443
local DEFAULT_WS    = 80
local DEFAULT_WSS   = 443

local RECOGNIZED = { http = true, https = true, ws = true, wss = true }

--- Build a new Ports table with defaults.
local function newPorts()
    return {
        http  = DEFAULT_HTTP,
        https = DEFAULT_HTTPS,
        ws    = DEFAULT_WS,
        wss   = DEFAULT_WSS,
    }
end

--- Parse a TXT record string as ADRP JSON.
--- Returns a ports table or nil if invalid.
local function parseTxt(txt)
    if type(txt) ~= "string" then return nil end
    txt = txt:match("^%s*(.-)%s*$")  -- trim
    if #txt == 0 or txt:sub(1, 1) ~= "{" then
        return nil
    end

    -- Minimal JSON parsing for ADRP's constrained format
    local found = {}
    local count = 0
    for key in pairs(RECOGNIZED) do
        -- Find "\"key\":"
        local search = '"' .. key .. '":'
        local start = txt:find(search, 1, true)
        if start then
            start = start + #search
            -- Skip whitespace after :
            while start <= #txt and (txt:sub(start, start) == ' ' or txt:sub(start, start) == '\t') do
                start = start + 1
            end
            -- Read integer digits
            local digits = txt:match("^(%d+)", start)
            if digits and #digits > 0 then
                local n = tonumber(digits)
                if n and n >= 1 and n <= 65535 then
                    found[key] = n
                    count = count + 1
                else
                    return nil  -- port out of range
                end
            else
                return nil  -- expected digit, got something else
            end
        end
    end

    if count == 0 then return nil end
    return found
end

--- Build a raw DNS query for TXT records.
local function buildQuery(domain)
    -- Header: ID(2) + FLAGS(2) + QDCOUNT(2) + ANCOUNT(2) + NSCOUNT(2) + ARCOUNT(2)
    local id1, id2 = math.random(0, 0xFF), math.random(0, 0xFF)
    local query = string.char(id1, id2,           -- ID
                              0x01, 0x00,         -- FLAGS: RD=1
                              0x00, 0x01,         -- QDCOUNT=1
                              0x00, 0x00,         -- ANCOUNT=0
                              0x00, 0x00,         -- NSCOUNT=0
                              0x00, 0x00)         -- ARCOUNT=0

    -- Question: QNAME + QTYPE + QCLASS
    for label in domain:gmatch("[^.]+") do
        query = query .. string.char(#label) .. label
    end
    query = query .. "\x00"                       -- null terminator
    query = query .. "\x00\x10"                   -- QTYPE=TXT
    query = query .. "\x00\x01"                   -- QCLASS=IN

    return query
end

--- Perform a raw UDP DNS query and parse TXT responses.
--- Returns a list of TXT value strings.
local function rawDnsQuery(domain, dnsServer)
    dnsServer = dnsServer or "8.8.8.8"

    -- Build DNS query
    local query = buildQuery(domain)

    -- Send via UDP
    local socket = require("socket")
    local udp = socket.udp()
    udp:settimeout(3)

    local ok, err = udp:sendto(query, dnsServer, 53)
    if not ok then
        udp:close()
        return {}
    end

    local response, err = udp:receive(4096)
    udp:close()

    if type(response) ~= "string" or #response < 12 then
        return {}
    end

    -- Parse DNS response
    local results = {}
    local anc = string.byte(response, 7) * 256 + string.byte(response, 8)
    if anc < 1 then return results end

    local pos = 13  -- skip header (12 bytes)
    -- Skip question
    while pos <= #response and string.byte(response, pos) ~= 0 do
        pos = pos + string.byte(response, pos) + 1
    end
    pos = pos + 5  -- null + QTYPE + QCLASS

    for i = 1, anc do
        if pos + 10 > #response then break end

        -- Skip NAME (handle compression pointer)
        if string.byte(response, pos) & 0xC0 == 0xC0 then
            pos = pos + 2
        else
            while pos <= #response and string.byte(response, pos) ~= 0 do
                pos = pos + string.byte(response, pos) + 1
            end
            pos = pos + 1
        end

        local rtype = string.byte(response, pos) * 256 + string.byte(response, pos + 1)
        pos = pos + 8  -- TYPE(2) + CLASS(2) + TTL(4)
        local rdlen = string.byte(response, pos) * 256 + string.byte(response, pos + 1)
        pos = pos + 2

        if rtype == 16 and rdlen > 1 then  -- TXT
            local txtlen = string.byte(response, pos)
            pos = pos + 1
            local txt = response:sub(pos, pos + math.min(txtlen, rdlen - 1) - 1)
            pos = pos + rdlen - 1
            table.insert(results, txt)
        else
            pos = pos + rdlen
        end
    end

    return results
end

--- Resolve KirinDNS ports for a domain.
function kirin_dns.resolve(domain)
    local ports = newPorts()

    local ok, txts = pcall(rawDnsQuery, domain)
    if not ok then return ports end

    for _, txt in ipairs(txts) do
        local parsed = parseTxt(txt)
        if parsed then
            for k, v in pairs(parsed) do
                ports[k] = v
            end
            return ports
        end
    end

    return ports
end

--- Parse a TXT value without network I/O (for testing).
function kirin_dns.parseTxt(txt)
    return parseTxt(txt)
end

-- ==========================================================================
-- Self-test (run: lua kirin_dns.lua)
-- ==========================================================================
if arg and arg[0]:match("kirin_dns") then
    -- Test parseTxt
    local p = parseTxt('{"http":8080,"https":8443}')
    assert(p ~= nil, "valid parse")
    assert(p.http == 8080, "http")
    assert(p.https == 8443, "https")
    assert(p.ws == nil, "ws not present")

    assert(parseTxt("{}") == nil, "empty")
    assert(parseTxt('{"http":0}') == nil, "port zero")
    assert(parseTxt("not json") == nil, "not json")

    print("KirinDNS Lua self-test: PASSED")
end

return kirin_dns
