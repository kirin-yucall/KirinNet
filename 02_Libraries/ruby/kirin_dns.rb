# kirin_dns.rb — KirinDNS Resolution Protocol (ADRP) Ruby Client
#
# Resolves service port mappings from DNS TXT records.
# Pure Ruby — only stdlib dependencies (resolv, json).
#
# Usage:
#   require_relative 'kirin_dns'
#   ports = KirinDNS.resolve('alice.kirinnet.org')
#   puts "HTTP: #{ports[:http]}"

require 'resolv'
require 'json'

module KirinDNS
  # Standard IANA fallback ports.
  FALLBACK = { http: 80, https: 443, ws: 80, wss: 443 }.freeze
  RECOGNIZED = %w[http https ws wss].to_set.freeze

  # Resolve KirinDNS ports for a domain.
  # Returns a Hash with keys :http, :https, :ws, :wss.
  # Falls back to standard ports if no valid ADRP record exists.
  def self.resolve(domain)
    ports = FALLBACK.dup

    begin
      resolver = Resolv::DNS.new
      records = resolver.getresources(domain, Resolv::DNS::Resource::IN::TXT)
    rescue Resolv::ResolvError
      return ports  # NXDOMAIN, timeout, etc. → fallback
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

  # Resolve using a custom DNS server.
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

  # Parse a TXT record string as ADRP JSON.
  # Returns a Hash of recognized keys, or nil if invalid.
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
      # Allow string numbers too (lenient)
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
    # Parse tests
    p = parse_txt('{"http":8080,"https":8443}')
    raise 'valid parse failed' unless p
    raise "http" unless p[:http] == 8080
    raise "https" unless p[:https] == 8443

    raise 'empty should be nil' if parse_txt('{}')
    raise 'port zero should be nil' if parse_txt('{"http":0}')
    raise 'not json should be nil' if parse_txt('not json')

    # Resolution test
    ports = resolve('nonexistent.invalid')
    raise 'fallback http' unless ports[:http] == 80
    raise 'fallback https' unless ports[:https] == 443

    puts "KirinDNS Ruby self-test: PASSED"
  end
end
