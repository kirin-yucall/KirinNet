/// KirinDNS Resolution Protocol (ADRP) v2.0 — Dart Client Library
///
/// Implements ADRP as defined in 01_Standard/spec_v1.md.
///
/// Architecture:
///   SRV records for service port discovery (_kirinnet-http._tcp, etc.)
///   TXT records for identity metadata (id=;key=;nick=;ipfs=)
///
/// Pure Dart — uses `dart:io` raw UDP for DNS queries.
///
/// Usage:
///   ```dart
///   import 'kirin_dns.dart';
///   final srv = await KirinDns.resolveService('alice.kirinnet.org', 'ws');
///   print(srv);  // SrvResult(target: alice.kirinnet.org, port: 8082)
///   final id = await KirinDns.resolveIdentity('alice.kirinnet.org');
///   print(id);  // {id: 550e8400-..., key: 04abc..., nick: Alice}
///   ```
///
/// Requires: Dart 3.0+

import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

// ---------------------------------------------------------------------------
// Constants (spec Section 2.2)
// ---------------------------------------------------------------------------

/// SRV service names.
const srvServices = <String, String>{
  'http': '_kirinnet-http._tcp',
  'https': '_kirinnet-https._tcp',
  'ws': '_kirinnet-ws._tcp',
};

/// Fallback ports when no SRV record exists.
const fallbackPorts = <String, int>{
  'http': 80,
  'https': 443,
  'ws': 80,
  'wss': 443,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Resolved SRV service target.
class SrvResult {
  final String target;
  final int port;

  const SrvResult({required this.target, required this.port});

  @override
  String toString() => 'SrvResult(target: $target, port: $port)';

  @override
  bool operator ==(Object other) =>
      other is SrvResult && other.target == target && other.port == port;

  @override
  int get hashCode => Object.hash(target, port);
}

/// Parsed identity from TXT record.
typedef KirinIdentity = Map<String, dynamic>;

// ---------------------------------------------------------------------------
// DNS wire format helpers
// ---------------------------------------------------------------------------

/// Build a DNS question section.
Uint8List _buildQuestion(String domain, int qtype) {
  final buf = BytesBuilder();
  for (final label in domain.split('.')) {
    final bytes = utf8.encode(label);
    buf.add([bytes.length]);
    buf.add(bytes);
  }
  buf.add([0x00]); // null terminator
  buf.add([qtype >> 8, qtype & 0xFF]); // QTYPE
  buf.add([0x00, 0x01]); // QCLASS=IN
  return Uint8List.fromList(buf.toBytes());
}

/// Build a complete DNS query packet.
Uint8List _buildQuery(String domain, int qtype) {
  final buf = BytesBuilder();
  final id = Random().nextInt(65536);
  buf.add([id >> 8, id & 0xFF]); // ID
  buf.add([0x01, 0x00]); // FLAGS: RD=1
  buf.add([0x00, 0x01]); // QDCOUNT=1
  buf.add([0x00, 0x00]); // ANCOUNT=0
  buf.add([0x00, 0x00]); // NSCOUNT=0
  buf.add([0x00, 0x00]); // ARCOUNT=0

  buf.add(_buildQuestion(domain, qtype));
  return Uint8List.fromList(buf.toBytes());
}

/// Read a domain name from DNS wire format at [pos].
/// Handles compression pointers (0xC0).
/// Returns (name, newPos).
(String, int) _readName(Uint8List data, int pos) {
  final name = StringBuffer();
  var jumped = false;
  var origPos = pos;
  var jumps = 0;

  while (pos < data.length) {
    final len = data[pos];
    if (len == 0) {
      pos++;
      break;
    }
    // Compression pointer
    if ((len & 0xC0) == 0xC0) {
      if (!jumped) origPos = pos + 2;
      final offset = ((len & 0x3F) << 8) | data[pos + 1];
      pos = offset;
      jumped = true;
      jumps++;
      if (jumps > 10) break; // prevent infinite loops
    } else {
      pos++;
      if (name.isNotEmpty) name.write('.');
      name.write(utf8.decode(data.sublist(pos, pos + len)));
      pos += len;
    }
  }

  return (name.toString(), jumped ? origPos : pos);
}

/// Send raw UDP DNS query and return response bytes.
Future<Uint8List?> _rawDnsQuery(String domain, int qtype,
    [String dnsServer = '8.8.8.8']) async {
  final query = _buildQuery(domain, qtype);
  final socket = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
  try {
    socket.send(query, InternetAddress(dnsServer), 53);
    final event = await socket
        .timeout(const Duration(seconds: 3))
        .firstWhere((e) => e == RawSocketEvent.read);
    final datagram = socket.receive();
    return datagram?.data;
  } catch (_) {
    return null;
  } finally {
    socket.close();
  }
}

/// Parse DNS response header: returns (qdcount, ancount).
(int, int) _parseHeader(Uint8List data) {
  if (data.length < 12) return (0, 0);
  final view = ByteData.view(data.buffer, data.offsetInBytes, data.length);
  final qdcount = view.getUint16(4);
  final ancount = view.getUint16(6);
  return (qdcount, ancount);
}

/// Skip question section, return position after it.
int _skipQuestions(Uint8List data, int pos, int qdcount) {
  for (var i = 0; i < qdcount; i++) {
    final (_, newPos) = _readName(data, pos);
    pos = newPos + 4; // QTYPE(2) + QCLASS(2)
  }
  return pos;
}

// ---------------------------------------------------------------------------
// TXT answer parsing
// ---------------------------------------------------------------------------

/// Parse TXT answers from DNS response starting at [pos].
List<String> _parseTxtAnswers(Uint8List data, int pos, int ancount) {
  final results = <String>[];
  for (var i = 0; i < ancount; i++) {
    if (pos + 10 > data.length) break;
    // Skip NAME
    final (_, afterName) = _readName(data, pos);
    pos = afterName;
    if (pos + 10 > data.length) break;

    final view = ByteData.view(data.buffer, data.offsetInBytes, data.length);
    final rtype = view.getUint16(pos);
    pos += 8; // TYPE(2) + CLASS(2) + TTL(4)
    final rdlen = view.getUint16(pos);
    pos += 2;

    if (rtype == 16 && rdlen > 1) {
      // TXT
      final txtLen = data[pos];
      pos++;
      final end = pos + (txtLen < rdlen - 1 ? txtLen : rdlen - 1);
      results.add(utf8.decode(data.sublist(pos, end)));
      pos += rdlen - 1;
    } else {
      pos += rdlen;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// SRV answer parsing
// ---------------------------------------------------------------------------

/// Parsed SRV record.
class _SrvRecord {
  final int priority;
  final int weight;
  final int port;
  final String target;

  const _SrvRecord(this.priority, this.weight, this.port, this.target);
}

/// Parse SRV answers from DNS response starting at [pos].
List<_SrvRecord> _parseSrvAnswers(Uint8List data, int pos, int ancount) {
  final results = <_SrvRecord>[];
  for (var i = 0; i < ancount; i++) {
    if (pos + 10 > data.length) break;
    // Skip NAME
    final (_, afterName) = _readName(data, pos);
    pos = afterName;
    if (pos + 10 > data.length) break;

    final view = ByteData.view(data.buffer, data.offsetInBytes, data.length);
    final rtype = view.getUint16(pos);
    pos += 8; // TYPE(2) + CLASS(2) + TTL(4)
    final rdlen = view.getUint16(pos);
    pos += 2;

    if (rtype == 33 && rdlen >= 6) {
      // SRV
      final rdataStart = pos;
      final priority = view.getUint16(pos);
      final weight = view.getUint16(pos + 2);
      final port = view.getUint16(pos + 4);
      final (target, _) = _readName(data, pos + 6);
      pos = rdataStart + rdlen;
      results.add(_SrvRecord(priority, weight, port, target));
    } else {
      pos += rdlen;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Service Resolution (SRV)
// ---------------------------------------------------------------------------

/// Resolve a single service port via SRV.
///
/// Returns [SrvResult] or null if no SRV record found.
Future<SrvResult?> resolveService(String domain, String service) async {
  final srvName = srvServices[service];
  if (srvName == null) {
    throw ArgumentError(
        'Unknown service: $service. Recognized: http, https, ws');
  }

  final fullName = '$srvName.$domain';
  final response = await _rawDnsQuery(fullName, 33);
  if (response == null || response.length < 12) return null;

  final (qdcount, ancount) = _parseHeader(response);
  if (ancount < 1) return null;

  var pos = _skipQuestions(response, 12, qdcount);
  final records = _parseSrvAnswers(response, pos, ancount);
  if (records.isEmpty) return null;

  // RFC 2782: sort by priority asc, then weight desc
  records.sort((a, b) {
    if (a.priority != b.priority) return a.priority.compareTo(b.priority);
    return b.weight.compareTo(a.weight);
  });

  final best = records.first;
  return SrvResult(target: best.target, port: best.port);
}

/// Resolve all SRV services for a domain.
Future<Map<String, SrvResult?>> resolveAllServices(String domain) async {
  final results = <String, SrvResult?>{};
  for (final svc in srvServices.keys) {
    results[svc] = await resolveService(domain, svc);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Identity Resolution (TXT)
// ---------------------------------------------------------------------------

/// Parse a semicolon-separated key=value TXT string into an identity map.
///
/// Format: id=<uuid>;key=<hex>;nick=<name>;ipfs=<bool>
/// (spec Section 3.2)
///
/// Returns null if not a valid identity record.
KirinIdentity? parseIdentityTxt(String txt) {
  final trimmed = txt.trim();
  if (trimmed.isEmpty || !trimmed.startsWith('id=')) return null;

  final result = <String, dynamic>{};
  for (final pair in trimmed.split(';')) {
    final eq = pair.indexOf('=');
    if (eq == -1) continue;
    final key = pair.substring(0, eq).trim();
    final val = pair.substring(eq + 1).trim();
    result[key] = val;
  }

  // Both id and key are required
  if (!result.containsKey('id') || !result.containsKey('key')) return null;

  // Parse ipfs boolean
  if (result.containsKey('ipfs')) {
    result['ipfs'] = result['ipfs'] == 'true';
  }

  return result;
}

/// Resolve identity metadata from TXT record.
Future<KirinIdentity?> resolveIdentity(String domain) async {
  final response = await _rawDnsQuery(domain, 16);
  if (response == null || response.length < 12) return null;

  final (qdcount, ancount) = _parseHeader(response);
  if (ancount < 1) return null;

  var pos = _skipQuestions(response, 12, qdcount);
  final txts = _parseTxtAnswers(response, pos, ancount);
  for (final txt in txts) {
    final identity = parseIdentityTxt(txt);
    if (identity != null) return identity;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Legacy Compatibility Wrapper
// ---------------------------------------------------------------------------

/// Full resolution: SRV + TXT + identity (legacy wrapper).
///
/// New code should use [resolveService] and [resolveIdentity] directly.
Future<Map<String, dynamic>> resolveKirinDns(String domain) async {
  final ws = await resolveService(domain, 'ws');
  return {
    'domain': domain,
    'ws': ws ?? SrvResult(target: domain, port: fallbackPorts['ws']!),
    'http': await resolveService(domain, 'http'),
    'https': await resolveService(domain, 'https'),
    'identity': await resolveIdentity(domain),
  };
}

// ---------------------------------------------------------------------------
// Self-test (run: dart run kirin_dns.dart)
// ---------------------------------------------------------------------------
Future<void> main() async {
  // SRV nonexistent domain
  final ws = await resolveService('nonexistent.invalid', 'ws');
  assert(ws == null, 'no SRV for nonexistent domain');

  // TXT identity nonexistent domain
  final id = await resolveIdentity('nonexistent.invalid');
  assert(id == null, 'no TXT identity for nonexistent domain');

  // Identity parser
  final parsed = parseIdentityTxt(
      'id=550e8400-e29b-41d4-a716-446655440000;key=04abc;nick=Alice;ipfs=false');
  assert(parsed != null, 'identity parsed');
  assert(parsed!['id'] == '550e8400-e29b-41d4-a716-446655440000', 'id');
  assert(parsed['key'] == '04abc', 'key');
  assert(parsed['nick'] == 'Alice', 'nick');
  assert(parsed['ipfs'] == false, 'ipfs bool');

  final minimal = parseIdentityTxt('id=test-id;key=0x00');
  assert(minimal != null, 'minimal');
  assert(minimal!['id'] == 'test-id', 'minimal id');
  assert(minimal['key'] == '0x00', 'minimal key');
  assert(!minimal.containsKey('nick'), 'no nick');

  // Invalid TXT
  assert(parseIdentityTxt('v=spf1 include:_spf.example.com') == null, 'spf');
  assert(parseIdentityTxt('') == null, 'empty');
  assert(parseIdentityTxt('not an identity') == null, 'not identity');

  // Legacy wrapper
  final full = await resolveKirinDns('nonexistent.invalid');
  final wsLegacy = full['ws'] as SrvResult;
  assert(wsLegacy.port == 80, 'legacy ws fallback');
  assert(full['http'] == null, 'legacy http null');
  assert(full['identity'] == null, 'legacy identity null');

  print('KirinDNS Dart self-test: PASSED');
}
