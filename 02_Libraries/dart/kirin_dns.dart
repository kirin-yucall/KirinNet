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
// did:dns three-record identity model (spec §3.2.1 / did-dns-protocol §2)
// ---------------------------------------------------------------------------
//
// Tamper-evident fingerprint chain: fp == Base64URL(SHA-256(pk)[0:12]).
// SHA-256 is implemented inline (FIPS 180-4) to avoid a pub dependency
// (`package:crypto`), keeping this a pure-Dart single-file library.

const _didDnsPrefix = 'did:dns:';
const _didDnsDeclPrefix = 'did:dns:v=';
const _didDnsPkPrefix = 'did:dns:pk;';
const _didDnsBlackPrefix = 'did:dns:black;';
const _didDnsKtyEd25519 = 'ed25519';
const _didDnsFingerprintBytes = 12; // -> 16 base64url chars

/// Verified did:dns identity (declaration + public key, optional blacklist).
class DidDnsIdentity {
  int version = 1;
  String fingerprint = '';
  String nickname = '';        // Base64URL(UTF-8)
  String gender = '';          // M/F/O/X
  int issuedAt = 0;
  int expiresAt = 0;
  String keyType = _didDnsKtyEd25519;
  String publicKeyB64Url = '';
  List<String> blacklist = [];

  /// Recompute fp = Base64URL(SHA-256(pk)[0:12]). Empty on malformed pk.
  String computeFingerprint() {
    final pk = _base64urlDecode(publicKeyB64Url);
    if (pk == null || pk.isEmpty) return '';
    final digest = _sha256(pk);
    return _base64urlEncode(digest.sublist(0, _didDnsFingerprintBytes));
  }

  /// True iff declared fp matches recomputed fp over the pk bytes.
  bool fingerprintChainOk() =>
      fingerprint.isNotEmpty && fingerprint == computeFingerprint();
  bool isRevoked() => blacklist.contains(fingerprint);
  bool isExpired(int now) => expiresAt != 0 && now >= expiresAt;
  /// Composite policy: v1 + ed25519 + chain + not revoked + not expired.
  bool isValid(int now) =>
      version == 1 &&
      keyType == _didDnsKtyEd25519 &&
      fingerprintChainOk() &&
      !isRevoked() &&
      !isExpired(now);

  /// Decode the Base64URL(UTF-8) nickname, or null if absent/invalid.
  String? nicknameDecoded() {
    if (nickname.isEmpty) return null;
    final bytes = _base64urlDecode(nickname);
    if (bytes == null) return null;
    return utf8.decode(bytes, allowMalformed: true);
  }
}

// ---- pure-Dart SHA-256 (FIPS 180-4) ------------------------------------
final _sha256K = [
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
];
const _mask32 = 0xFFFFFFFF;

List<int> _sha256(List<int> data) {
  int rotl(int x, int n) => ((x << n) | (x >> (32 - n))) & _mask32;
  int rotr(int x, int n) => (x >> n) | ((x << (32 - n)) & _mask32);
  final bytes = List<int>.from(data);
  final bitLen = bytes.length * 8;
  bytes.add(0x80);
  while (bytes.length % 64 != 56) bytes.add(0);
  for (int i = 7; i >= 0; i--) bytes.add((bitLen >> (i * 8)) & 0xff);
  var h = [
    0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
    0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19
  ];
  for (int off = 0; off < bytes.length; off += 64) {
    final m = List<int>.filled(64, 0);
    for (int i = 0; i < 16; i++) {
      m[i] = ((bytes[off + i * 4] << 24) |
              (bytes[off + i * 4 + 1] << 16) |
              (bytes[off + i * 4 + 2] << 8) |
              bytes[off + i * 4 + 3]) &
          _mask32;
    }
    for (int i = 16; i < 64; i++) {
      final s0 = rotr(m[i - 15], 7) ^ rotr(m[i - 15], 18) ^ (m[i - 15] >> 3);
      final s1 = rotr(m[i - 2], 17) ^ rotr(m[i - 2], 19) ^ (m[i - 2] >> 10);
      m[i] = (m[i - 16] + s0 + m[i - 7] + s1) & _mask32;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3];
    var e = h[4], f = h[5], g = h[6], hh = h[7];
    for (int i = 0; i < 64; i++) {
      final s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      final ch = (e & f) ^ ((~e & _mask32) & g);
      final t1 = (hh + s1 + ch + _sha256K[i] + m[i]) & _mask32;
      final s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      final maj = (a & b) ^ (a & c) ^ (b & c);
      final t2 = (s0 + maj) & _mask32;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) & _mask32;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) & _mask32;
    }
    h[0] = (h[0] + a) & _mask32;
    h[1] = (h[1] + b) & _mask32;
    h[2] = (h[2] + c) & _mask32;
    h[3] = (h[3] + d) & _mask32;
    h[4] = (h[4] + e) & _mask32;
    h[5] = (h[5] + f) & _mask32;
    h[6] = (h[6] + g) & _mask32;
    h[7] = (h[7] + hh) & _mask32;
  }
  final out = <int>[];
  for (int i = 0; i < 8; i++) {
    out.add((h[i] >> 24) & 0xff);
    out.add((h[i] >> 16) & 0xff);
    out.add((h[i] >> 8) & 0xff);
    out.add(h[i] & 0xff);
  }
  return out;
}

const _b64urlAlphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/// Base64URL encode (RFC 4648 §5, no padding).
String _base64urlEncode(List<int> bytes) {
  var val = 0, valb = -6;
  final out = StringBuffer();
  for (final b in bytes) {
    val = ((val << 8) | b) & _mask32;
    valb += 8;
    while (valb >= 0) {
      out.write(_b64urlAlphabet[(val >> valb) & 0x3f]);
      valb -= 6;
    }
  }
  if (valb > -6) {
    out.write(_b64urlAlphabet[((val << 8) >> (valb + 8)) & 0x3f]);
  }
  return out.toString();
}

/// Base64URL decode (no padding). Returns null on invalid char.
List<int>? _base64urlDecode(String s) {
  final rev = List<int>.filled(256, -1);
  for (int i = 0; i < 64; i++) {
    rev[_b64urlAlphabet.codeUnitAt(i)] = i;
  }
  var val = 0, valb = -8;
  final out = <int>[];
  for (final cu in s.codeUnits) {
    if (cu == 0x3d) continue; // '='
    final d = rev[cu];
    if (d < 0) return null;
    val = ((val << 6) | d) & _mask32;
    valb += 6;
    if (valb >= 0) {
      out.add((val >> valb) & 0xff);
      valb -= 8;
    }
  }
  return out;
}

Map<String, String> _parseDidDnsKv(String segment) {
  final out = <String, String>{};
  for (final pair in segment.split(';')) {
    final eq = pair.indexOf('=');
    if (eq == -1) continue;
    final k = pair.substring(0, eq).trim();
    final v = pair.substring(eq + 1).trim();
    out[k] = v;
  }
  return out;
}

/// Classify TXT records by did:dns: sub-type; assemble an identity.
/// Returns null if no did:dns records / declaration+pk missing.
DidDnsIdentity? parseDidDnsIdentity(List<String> txtRecords) {
  String? declRaw, pkRaw, blackRaw;
  for (final raw in txtRecords) {
    final s = raw.trim();
    if (declRaw == null && s.startsWith(_didDnsDeclPrefix)) {
      declRaw = s;
    } else if (pkRaw == null && s.startsWith(_didDnsPkPrefix)) {
      pkRaw = s;
    } else if (blackRaw == null && s.startsWith(_didDnsBlackPrefix)) {
      blackRaw = s;
    }
  }
  if (declRaw == null || pkRaw == null) return null;

  final decl = _parseDidDnsKv(declRaw.substring(_didDnsPrefix.length));
  final pk = _parseDidDnsKv(pkRaw.substring(_didDnsPrefix.length));

  final id = DidDnsIdentity()
    ..version = int.tryParse(decl['v'] ?? '1') ?? 1
    ..fingerprint = decl['fp'] ?? ''
    ..nickname = decl['n'] ?? ''
    ..gender = decl['g'] ?? ''
    ..issuedAt = int.tryParse(decl['iat'] ?? '0') ?? 0
    ..expiresAt = int.tryParse(decl['exp'] ?? '0') ?? 0
    ..keyType = pk['kty'] ?? _didDnsKtyEd25519
    ..publicKeyB64Url = pk['pk'] ?? '';

  if (blackRaw != null) {
    final bkv = _parseDidDnsKv(blackRaw.substring(_didDnsPrefix.length));
    final fpField = bkv['fp'] ?? '';
    id.blacklist = fpField
        .split(',')
        .where((f) => f.isNotEmpty)
        .toList();
  }
  return id;
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
  final parsedNullable = parseIdentityTxt(
      'id=550e8400-e29b-41d4-a716-446655440000;key=04abc;nick=Alice;ipfs=false');
  assert(parsedNullable != null, 'identity parsed');
  final parsed = parsedNullable!;
  assert(parsed['id'] == '550e8400-e29b-41d4-a716-446655440000', 'id');
  assert(parsed['key'] == '04abc', 'key');
  assert(parsed['nick'] == 'Alice', 'nick');
  assert(parsed['ipfs'] == false, 'ipfs bool');

  final minimalNullable = parseIdentityTxt('id=test-id;key=0x00');
  assert(minimalNullable != null, 'minimal');
  final minimal = minimalNullable!;
  assert(minimal['id'] == 'test-id', 'minimal id');
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

  // ---- did:dns three-record identity model (C-1 baseline) ----
  // Deterministic 32-byte key = bytes 0..31 (matches the golden vector).
  final pkBytes = List<int>.generate(32, (i) => i);
  final pkB64 = _base64urlEncode(pkBytes);
  final dg = _sha256(pkBytes);
  final fpCalc = _base64urlEncode(dg.sublist(0, _didDnsFingerprintBytes));
  const now = 1700000000;

  final recs = [
    'v=spf1 include:_spf.kirinnet.org -all',
    'did:dns:v=1;fp=$fpCalc;n=QWxpY2U;g=F;iat=$now;exp=${now + 3600}',
    'did:dns:pk;kty=ed25519;pk=$pkB64',
    'did:dns:black;fp=RevokedAaaa,RevokedBbbb',
  ];
  final did = parseDidDnsIdentity(recs)!;
  assert(did.version == 1, 'did:dns version');
  assert(did.fingerprint == fpCalc, 'did:dns fp');
  assert(did.keyType == 'ed25519', 'did:dns kty');
  assert(did.fingerprintChainOk(), 'did:dns fingerprint chain');
  assert(did.isValid(now), 'did:dns valid');
  assert(did.nicknameDecoded() == 'Alice', 'did:dns nickname decode');
  assert(!did.isRevoked(), 'did:dns not revoked');

  // Tampered pk -> chain breaks
  final wrong = List<int>.filled(32, 0xff);
  final wrongB64 = _base64urlEncode(wrong);
  final tampered = List<String>.from(recs)
    ..[2] = 'did:dns:pk;kty=ed25519;pk=$wrongB64';
  final broken = parseDidDnsIdentity(tampered)!;
  assert(!broken.fingerprintChainOk(), 'tampered pk breaks chain');

  // Missing pk -> null
  assert(parseDidDnsIdentity([recs[1]]) == null, 'missing pk -> null');
  // No did:dns -> null (legacy id= ignored)
  assert(parseDidDnsIdentity(['v=spf1 -all', 'id=foo;key=bar']) == null,
      'no did:dns -> null');
  // Wrong kty -> invalid
  final rsaId =
      parseDidDnsIdentity([recs[1], 'did:dns:pk;kty=rsa;pk=$pkB64'])!;
  assert(rsaId.keyType == 'rsa' && !rsaId.isValid(now), 'rsa kty rejected');

  print('KirinDNS Dart self-test: PASSED (incl. did:dns fingerprint chain)');
}
