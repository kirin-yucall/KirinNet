# kirin_dns.rb — KirinDNS Resolution Protocol (ADRP) v2.0 Ruby Client
#
# SRV records for service port discovery (_kirinnet-http._tcp, etc.)
# TXT records for identity metadata (id=;key=;nick=;ipfs=)
# Legacy ADRP JSON TXT fallback preserved for backward compatibility.
#
# Pure Ruby — only stdlib dependencies (resolv, json).
#
# Usage:
#   require_relative 'kirin_dns'
#   srv = KirinDNS.resolve_service('alice.kirinnet.org', 'ws')
#   puts "WS: #{srv[:target]}:#{srv[:port]}"
#   id = KirinDNS.resolve_identity('alice.kirinnet.org')
#   puts "ID: #{id[:id]}"

require 'resolv'
require 'json'
require 'set'
require 'digest'
require 'base64'

module KirinDNS
  # SRV service names (spec Section 2.2)
  SRV_SERVICES = {
    http:  '_kirinnet-http._tcp',
    https: '_kirinnet-https._tcp',
    ws:    '_kirinnet-ws._tcp'
  }.freeze

  # Fallback ports (spec Section 3.3.1, Step 4)
  FALLBACK = { http: 80, https: 443, ws: 80, wss: 443 }.freeze

  # Legacy ADRP JSON recognized keys
  RECOGNIZED = %w[http https ws wss].to_set.freeze

  # ---------------------------------------------------------------------------
  # Service Resolution (SRV)
  # ---------------------------------------------------------------------------

  # Resolve a single service port via SRV.
  #
  # @param domain  [String] e.g., 'alice.kirinnet.org'
  # @param service [String] 'http', 'https', or 'ws'
  # @return [Hash{Symbol=>String,Integer}, nil]
  #   { target: 'alice.kirinnet.org', port: 8082 } or nil if no SRV record.
  def self.resolve_service(domain, service)
    srv_name = SRV_SERVICES[service.to_sym]
    raise ArgumentError, "Unknown service: #{service}. Recognized: http, https, ws" unless srv_name

    full_name = "#{srv_name}.#{domain}"

    begin
      resolver = Resolv::DNS.new
      records = resolver.getresources(full_name, Resolv::DNS::Resource::IN::SRV)
    rescue Resolv::ResolvError
      return nil
    end

    return nil if records.nil? || records.empty?

    # RFC 2782: lowest priority, then highest weight
    best = records.min_by { |r| [r.priority, -r.weight] }
    { target: best.target.to_s.sub(/\.\z/, ''), port: best.port }
  end

  # Resolve all SRV services for a domain.
  #
  # @param domain [String]
  # @return [Hash]
  #   { http: {target:, port:}|nil, https: ..., ws: ... }
  def self.resolve_all_services(domain)
    SRV_SERVICES.each_key.each_with_object({}) do |svc, hash|
      hash[svc] = resolve_service(domain, svc.to_s)
    end
  end

  # ---------------------------------------------------------------------------
  # Legacy Wrapper (all-in-one resolution)
  # ---------------------------------------------------------------------------

  # Full resolution: SRV + TXT identity.
  #
  # @param domain [String]
  # @return [Hash]
  #   { domain:, ws:, http:, https:, identity: }
  def self.resolve_kirin_dns(domain)
    {
      domain: domain,
      ws: resolve_service(domain, 'ws') || { target: domain, port: FALLBACK[:ws] },
      http: resolve_service(domain, 'http'),
      https: resolve_service(domain, 'https'),
      identity: resolve_identity(domain)
    }
  end

  # ---------------------------------------------------------------------------
  # Identity Resolution (TXT)
  # ---------------------------------------------------------------------------

  # Parse a semicolon-separated key=value TXT string into an identity hash.
  #
  # Format: id=<uuid>;key=<hex>;nick=<name>;ipfs=<bool>
  # (spec Section 3.2)
  #
  # @param txt [String] Raw TXT record value.
  # @return [Hash, nil] Parsed identity, or nil if not a valid identity record.
  def self.parse_identity_txt(txt)
    return nil if txt.nil? || txt.strip.empty?
    return nil unless txt.start_with?('id=')

    result = {}
    txt.split(';').each do |pair|
      eq = pair.index('=')
      next unless eq
      key = pair[0...eq].strip
      val = pair[(eq + 1)..].strip
      result[key] = val
    end

    # Both id and key are required
    return nil unless result['id'] && result['key']

    # Parse ipfs boolean if present
    if result.key?('ipfs')
      result['ipfs'] = result['ipfs'].downcase == 'true'
    end

    result.transform_keys(&:to_sym)
  end

  # Resolve identity metadata from TXT records.
  #
  # @param domain [String]
  # @return [Hash, nil]
  #   { id:, key:, nick?:, ipfs?: } or nil if no identity TXT found.
  def self.resolve_identity(domain)
    begin
      resolver = Resolv::DNS.new
      records = resolver.getresources(domain, Resolv::DNS::Resource::IN::TXT)
    rescue Resolv::ResolvError
      return nil
    end

    records.each do |record|
      txt = record.strings.join('')
      identity = parse_identity_txt(txt)
      return identity if identity
    end

    nil
  end

  # ---------------------------------------------------------------------------
  # Legacy ADRP API (backward compatibility)
  # ---------------------------------------------------------------------------

  # Resolve KirinDNS ports for a domain using legacy ADRP JSON TXT.
  #
  # @param domain [String]
  # @return [Hash] with keys :http, :https, :ws, :wss
  def self.resolve(domain)
    ports = FALLBACK.dup

    begin
      resolver = Resolv::DNS.new
      records = resolver.getresources(domain, Resolv::DNS::Resource::IN::TXT)
    rescue Resolv::ResolvError
      return ports
    end

    records.each do |record|
      txt = record.strings.join('')
      parsed = parse_txt(txt)
      next unless parsed

      ports.merge!(parsed)
      return ports
    end

    ports
  end

  # Resolve using a custom DNS server (legacy API).
  def self.resolve_with_server(domain, dns_server)
    ports = FALLBACK.dup

    begin
      resolver = Resolv::DNS.new(nameserver: [dns_server])
      records = resolver.getresources(domain, Resolv::DNS::Resource::IN::TXT)
    rescue Resolv::ResolvError
      return ports
    end

    records.each do |record|
      txt = record.strings.join('')
      parsed = parse_txt(txt)
      next unless parsed

      ports.merge!(parsed)
      return ports
    end

    ports
  end

  # Parse a TXT record string as legacy ADRP JSON.
  def self.parse_txt(txt)
    return nil if txt.nil? || txt.strip.empty?

    begin
      data = JSON.parse(txt)
    rescue JSON::ParserError
      return nil
    end

    return nil unless data.is_a?(Hash)
    return nil if data.empty?

    result = {}
    RECOGNIZED.each do |key|
      val = data[key]
      next if val.nil?
      val = val.to_i if val.is_a?(String) && val.match?(/\A\d+\z/)
      return nil unless val.is_a?(Integer)
      return nil if val < 1 || val > 65535
      result[key.to_sym] = val
    end

    return nil if result.empty?
    result
  end

  # ---------------------------------------------------------------------------
  # did:dns three-record identity model (spec §3.2.1 / did-dns-protocol §2)
  # ---------------------------------------------------------------------------
  #
  # Tamper-evident fingerprint chain: fp == Base64URL(SHA-256(pk)[0:12]).
  # Uses Ruby stdlib Digest::SHA256 + Base64.urlsafe_encode/decode.

  DID_DNS_PREFIX       = 'did:dns:'.freeze
  DID_DNS_DECL_PREFIX  = 'did:dns:v='.freeze
  DID_DNS_PK_PREFIX    = 'did:dns:pk;'.freeze
  DID_DNS_BLACK_PREFIX = 'did:dns:black;'.freeze
  DID_DNS_KTY_ED25519  = 'ed25519'.freeze
  DID_DNS_FINGERPRINT_BYTES = 12   # -> 16 base64url chars

  # Base64URL decode (no padding). Returns the raw binary string, or nil.
  def self.base64url_decode(str)
    return nil if str.nil? || str.empty?
    pad = str.length % 4
    str = str + ('=' * (4 - pad)) if pad > 0
    Base64.urlsafe_decode64(str)
  rescue ArgumentError
    nil
  end

  # Base64URL encode (no padding).
  def self.base64url_encode(binary)
    Base64.urlsafe_encode64(binary, padding: false)
  end

  # Create a new DidDnsIdentity hash with defaults.
  def self.new_did_dns_identity
    {
      version: 1,
      fingerprint: '',
      nickname: '',       # Base64URL(UTF-8)
      gender: '',         # M/F/O/X
      issued_at: 0,
      expires_at: 0,
      key_type: DID_DNS_KTY_ED25519,
      public_key_b64url: '',
      blacklist: []
    }
  end

  # Recompute fp = Base64URL(SHA-256(pk)[0:12]). Empty string on malformed pk.
  def self.compute_fingerprint(id)
    pk = base64url_decode(id[:public_key_b64url])
    return '' if pk.nil? || pk.empty?
    digest = Digest::SHA256.digest(pk)
    base64url_encode(digest[0, DID_DNS_FINGERPRINT_BYTES])
  end

  # True iff declared fp matches recomputed fp over the pk bytes.
  def self.fingerprint_chain_ok?(id)
    !id[:fingerprint].empty? && id[:fingerprint] == compute_fingerprint(id)
  end

  def self.revoked?(id)
    id[:blacklist].include?(id[:fingerprint])
  end

  def self.expired?(id, now)
    id[:expires_at] != 0 && now >= id[:expires_at]
  end

  # Composite policy: v1 + ed25519 + chain + not revoked + not expired.
  def self.did_dns_valid?(id, now)
    id[:version] == 1 &&
      id[:key_type] == DID_DNS_KTY_ED25519 &&
      fingerprint_chain_ok?(id) &&
      !revoked?(id) &&
      !expired?(id, now)
  end

  # Parse a `k=v;k=v` segment (after the did:dns: prefix) into a hash.
  def self.parse_did_dns_kv(segment)
    out = {}
    segment.split(';').each do |pair|
      eq = pair.index('=')
      next unless eq
      k = pair[0...eq].strip
      v = pair[(eq + 1)..].strip
      out[k] = v
    end
    out
  end

  # Classify TXT records by did:dns: sub-type; assemble an identity.
  # Returns nil if no did:dns records / declaration+pk missing.
  def self.parse_did_dns_identity(txt_records)
    decl_raw = pk_raw = black_raw = nil
    txt_records.each do |raw|
      s = raw.to_s.strip
      if decl_raw.nil? && s.start_with?(DID_DNS_DECL_PREFIX)
        decl_raw = s
      elsif pk_raw.nil? && s.start_with?(DID_DNS_PK_PREFIX)
        pk_raw = s
      elsif black_raw.nil? && s.start_with?(DID_DNS_BLACK_PREFIX)
        black_raw = s
      end
    end
    return nil if decl_raw.nil? || pk_raw.nil?

    decl = parse_did_dns_kv(decl_raw[DID_DNS_PREFIX.length..])
    pk   = parse_did_dns_kv(pk_raw[DID_DNS_PREFIX.length..])

    id = new_did_dns_identity
    id[:version]           = decl.key?('v') ? decl['v'].to_i : 1
    id[:fingerprint]       = decl['fp'] || ''
    id[:nickname]          = decl['n'] || ''
    id[:gender]            = decl['g'] || ''
    id[:issued_at]         = decl.key?('iat') ? decl['iat'].to_i : 0
    id[:expires_at]        = decl.key?('exp') ? decl['exp'].to_i : 0
    id[:key_type]          = pk['kty'] || DID_DNS_KTY_ED25519
    id[:public_key_b64url] = pk['pk'] || ''

    unless black_raw.nil?
      bkv = parse_did_dns_kv(black_raw[DID_DNS_PREFIX.length..])
      fp_field = bkv['fp'] || ''
      id[:blacklist] = fp_field.split(',').reject(&:empty?)
    end
    id
  end

  # ---- self-test ----------------------------------------------------------
  if __FILE__ == $PROGRAM_NAME
    # Legacy parse tests
    p = parse_txt('{"http":8080,"https":8443}')
    raise 'valid parse failed' unless p
    raise 'http' unless p[:http] == 8080
    raise 'https' unless p[:https] == 8443

    raise 'empty should be nil' if parse_txt('{}')
    raise 'port zero should be nil' if parse_txt('{"http":0}')
    raise 'not json should be nil' if parse_txt('not json')

    # Resolution test
    ports = resolve('nonexistent.invalid')
    raise 'fallback http' unless ports[:http] == 80
    raise 'fallback https' unless ports[:https] == 443

    # ---- v2 identity parser tests ----

    parsed = parse_identity_txt(
      'id=550e8400-e29b-41d4-a716-446655440000;key=04abc;nick=Alice;ipfs=false'
    )
    raise 'valid identity failed' unless parsed
    raise 'id' unless parsed[:id] == '550e8400-e29b-41d4-a716-446655440000'
    raise 'key' unless parsed[:key] == '04abc'
    raise 'nick' unless parsed[:nick] == 'Alice'
    raise 'ipfs false' unless parsed[:ipfs] == false

    # Minimal identity
    minimal = parse_identity_txt('id=test-id;key=0x00')
    raise 'minimal id' unless minimal[:id] == 'test-id'
    raise 'minimal key' unless minimal[:key] == '0x00'
    raise 'no nick' if minimal.key?(:nick)

    # Invalid identities
    raise 'not identity' if parse_identity_txt('not an identity')
    raise 'spf record' if parse_identity_txt('v=spf1 include:_spf.example.com')
    raise 'empty' if parse_identity_txt('')
    raise 'nil' if parse_identity_txt(nil)
    raise 'no key' if parse_identity_txt('id=foo;nick=Bar')

    # ---- v2 SRV tests ----

    srv = resolve_service('nonexistent.invalid', 'ws')
    raise 'nil srv for nonexistent' unless srv.nil?

    begin
      resolve_service('example.com', 'bogus')
      raise 'should have raised'
    rescue ArgumentError
      # expected
    end

    all_srv = resolve_all_services('nonexistent.invalid')
    raise 'all nil' unless all_srv.values.all?(&:nil?)

    identity = resolve_identity('nonexistent.invalid')
    raise 'nil identity for nonexistent' unless identity.nil?

    puts 'KirinDNS Ruby self-test: PASSED'

    # ---- did:dns three-record identity model (C-1 baseline) ----
    # Deterministic 32-byte key = bytes 0..31 (matches the golden vector).
    pk_bytes = (0..31).to_a.pack('C*')
    pk_b64 = base64url_encode(pk_bytes)
    dg = Digest::SHA256.digest(pk_bytes)
    fp_calc = base64url_encode(dg[0, DID_DNS_FINGERPRINT_BYTES])
    now = 1_700_000_000

    recs = [
      'v=spf1 include:_spf.kirinnet.org -all',
      "did:dns:v=1;fp=#{fp_calc};n=QWxpY2U;g=F;iat=#{now};exp=#{now + 3600}",
      "did:dns:pk;kty=ed25519;pk=#{pk_b64}",
      'did:dns:black;fp=RevokedAaaa,RevokedBbbb'
    ]
    did = parse_did_dns_identity(recs)
    raise 'did:dns identity' unless did
    raise 'did:dns version' unless did[:version] == 1
    raise 'did:dns fp' unless did[:fingerprint] == fp_calc
    raise 'did:dns kty' unless did[:key_type] == 'ed25519'
    raise 'did:dns chain' unless fingerprint_chain_ok?(did)
    raise 'did:dns valid' unless did_dns_valid?(did, now)
    raise 'did:dns not revoked' if revoked?(did)

    # Tampered pk -> chain breaks
    wrong_b64 = base64url_encode("\xff" * 32)
    tampered = [recs[0], recs[1], "did:dns:pk;kty=ed25519;pk=#{wrong_b64}"]
    broken = parse_did_dns_identity(tampered)
    raise 'tampered pk breaks chain' if fingerprint_chain_ok?(broken)

    # Missing pk -> nil
    raise 'missing pk -> nil' unless parse_did_dns_identity([recs[1]]).nil?
    # No did:dns -> nil (legacy id= ignored)
    raise 'no did:dns -> nil' unless parse_did_dns_identity(['v=spf1 -all', 'id=foo;key=bar']).nil?
    # Wrong kty -> invalid
    rsa_id = parse_did_dns_identity([recs[1], "did:dns:pk;kty=rsa;pk=#{pk_b64}"])
    raise 'rsa kty rejected' unless rsa_id[:key_type] == 'rsa' && !did_dns_valid?(rsa_id, now)

    puts 'KirinDNS Ruby did:dns self-test: PASSED (fingerprint chain)'
  end
end
