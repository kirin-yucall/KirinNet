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
  end
end
