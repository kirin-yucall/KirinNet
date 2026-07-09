/// KirinDNS Resolution Protocol (ADRP) — Dart Client
///
/// Resolves service port mappings from DNS TXT records.
/// Pure Dart — uses `dart:io` InternetAddress.lookup and raw UDP.
///
/// Usage:
///   ```dart
///   import 'kirin_dns.dart';
///   final ports = await KirinDns.resolve('alice.kirinnet.org');
///   print('HTTP: ${ports.http}');
///   ```
///
/// Requires: Dart 3.0+

import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'dart:typed_data';

/// Recognized ADRP transport keys.
const _recognized = {'http', 'https', 'ws', 'wss'};

/// Fallback default ports.
const _defaultHttp = 80;
const _defaultHttps = 443;
const _defaultWs = 80;
const _defaultWss = 443;

/// Resolved KirinDNS service ports.
class KirinPorts {
  final int http;
  final int https;
  final int ws;
  final int wss;

  const KirinPorts({
    this.http = _defaultHttp,
    this.https = _defaultHttps,
    this.ws = _defaultWs,
    this.wss = _defaultWss,
  });

  static const fallback = KirinPorts();

  @override
  bool operator ==(Object other) =>
      other is KirinPorts &&
      other.http == http &&
      other.https == https &&
      other.ws == ws &&
      other.wss == wss;

  @override
  int get hashCode => Object.hash(http, https, ws, wss);

  @override
  String toString() => 'KirinPorts(http=$http, https=$https, ws=$ws, wss=$wss)';
}

/// Resolve KirinDNS ports for a domain.
/// Returns fallback ports if no valid ADRP TXT record exists.
Future<KirinPorts> resolve(String domain) async {
  try {
    final raw = await _rawDnsQuery(domain);
    if (raw == null) return KirinPorts.fallback;

    final txts = _parseRawTxtResponses(raw);
    for (final txt in txts) {
      final parsed = parseTxt(txt);
      if (parsed != null) return parsed;
    }
  } catch (_) {
    // Resolution error → fallback
  }

  return KirinPorts.fallback;
}

/// Parse a TXT record string as ADRP JSON.
/// Returns null if not a valid ADRP record.
KirinPorts? parseTxt(String txt) {
  final trimmed = txt.trim();
  if (trimmed.isEmpty || !trimmed.startsWith('{')) return null;

  Map<String, dynamic> data;
  try {
    data = jsonDecode(trimmed) as Map<String, dynamic>;
  } catch (_) {
    return null;
  }

  if (data.isEmpty) return null;

  var http = 0, https = 0, ws = 0, wss = 0;
  var found = 0;

  for (final key in _recognized) {
    if (!data.containsKey(key)) continue;

    final val = data[key];
    if (val is! num) return null;

    final p = val.toInt();
    if (p < 1 || p > 65535) return null;

    switch (key) {
      case 'http':  http = p;  break;
      case 'https': https = p; break;
      case 'ws':    ws = p;    break;
      case 'wss':   wss = p;   break;
    }
    found++;
  }

  if (found == 0) return null;

  return KirinPorts(
    http:  http > 0 ? http  : _defaultHttp,
    https: https > 0 ? https : _defaultHttps,
    ws:    ws > 0 ? ws    : _defaultWs,
    wss:   wss > 0 ? wss   : _defaultWss,
  );
}

// ---- internal raw UDP DNS query helpers -------------------------------

Future<Uint8List?> _rawDnsQuery(String domain) async {
  final query = _buildDnsQuery(domain);
  final socket = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
  try {
    socket.send(query, InternetAddress('8.8.8.8'), 53);
    final response = await socket
        .timeout(const Duration(seconds: 3))
        .firstWhere((e) => e == RawSocketEvent.read)
        .then((_) => socket.receive());
    return response?.data;
  } catch (_) {
    return null;
  } finally {
    socket.close();
  }
}

Uint8List _buildDnsQuery(String domain) {
  final buf = BytesBuilder();
  final id = Random().nextInt(65536);
  buf.add([id >> 8, id & 0xFF]);           // ID
  buf.add([0x01, 0x00]);                   // FLAGS: standard query, RD
  buf.add([0x00, 0x01]);                   // QDCOUNT=1
  buf.add([0x00, 0x00]);                   // ANCOUNT=0
  buf.add([0x00, 0x00]);                   // NSCOUNT=0
  buf.add([0x00, 0x00]);                   // ARCOUNT=0

  for (final label in domain.split('.')) {
    final bytes = utf8.encode(label);
    buf.add([bytes.length]);
    buf.add(bytes);
  }
  buf.add([0x00]);                          // null terminator
  buf.add([0x00, 0x10]);                   // QTYPE=TXT (16)
  buf.add([0x00, 0x01]);                   // QCLASS=IN

  return Uint8List.fromList(buf.toBytes());
}

List<String> _parseRawTxtResponses(Uint8List raw) {
  final results = <String>[];
  if (raw.length < 12) return results;
  final data = ByteData.view(raw.buffer, raw.offsetInBytes, raw.length);
  final qdcount = data.getUint16(4);
  if (qdcount < 1) return results;

  final ancount = data.getUint16(6);
  if (ancount < 1) return results;

  var pos = 12;
  // Skip question
  while (pos < raw.length && raw[pos] != 0) {
    pos += raw[pos] + 1;
  }
  pos += 5; // null + QTYPE + QCLASS

  for (var i = 0; i < ancount && pos < raw.length; i++) {
    // Skip NAME (handle compression)
    if ((raw[pos] & 0xC0) == 0xC0) {
      pos += 2;
    } else {
      while (pos < raw.length && raw[pos] != 0) pos += raw[pos] + 1;
      pos++;
    }
    if (pos + 10 > raw.length) break;
    final rtype = data.getUint16(pos);
    pos += 8; // TYPE + CLASS + TTL
    final rdlen = data.getUint16(pos);
    pos += 2;
    if (rtype == 16 && rdlen > 1) {
      final txtlen = raw[pos];
      pos++;
      results.add(utf8.decode(raw.sublist(pos, pos + min(txtlen, rdlen - 1))));
      pos += rdlen - 1;
    } else {
      pos += rdlen;
    }
  }
  return results;
}

// ---- self-test (run: dart run kirin_dns.dart) -------------------------
Future<void> main() async {
  // Parse tests
  var p = parseTxt('{"http":8080,"https":8443}');
  assert(p != null, 'valid parse');
  assert(p!.http == 8080, 'http');
  assert(p.https == 8443, 'https');
  assert(p.ws == 80, 'ws fallback');
  assert(p.wss == 443, 'wss fallback');

  assert(parseTxt('{}') == null, 'empty');
  assert(parseTxt('{"http":0}') == null, 'port zero');
  assert(parseTxt('not json') == null, 'not json');

  // Resolution test (fallback)
  final ports = await resolve('nonexistent.invalid');
  assert(ports.http == 80, 'fallback http');
  assert(ports.https == 443, 'fallback https');

  print('KirinDns Dart self-test: PASSED');
}
