# KirinDNS Browser — Patch Notes

## Overview

**Product**: KirinDNS Browser  
**Base**: Chromium 135.0.xxxxx.x  
**Core Code Changes**: None  

KirinDNS Browser is a customized build of Chromium that includes the KirinDNS
Resolver extension pre-installed and enabled by default. No core Chromium C++
or JavaScript code has been modified. All changes are limited to the extension
registration and build configuration.

---

## Changes Summary

### 1. Extension Integration (No Core Code Changes)

The KirinDNS extension is integrated via Chromium's built-in extension mechanism:

- **Added**: `chrome/extensions/aura_dns/` directory containing the KirinDNS
  extension (Manifest V3)
- **Modified**: `chrome/extensions/BUILD.gn` — added a `component_extension`
  block for `aura_dns`
- **Modified**: `chrome/browser/resources/settings/extensions_page/extension_ids.json`
  — added the KirinDNS Resolver entry with its extension ID

These changes are additive only; no existing Chromium code is altered.

### 2. Build Configuration (Optional Branding)

If branding is enabled, the following additional changes apply:

- **Modified**: `gn gen` args to include `branding="KirinDNS"`
- **Added**: `chrome/app/theme/chrome/KirinDNS/` directory with custom icons
- **No source code changes**: branding is applied through build-time resource
  substitution, not code modification

---

## File Change List

| File | Change Type | Description |
|------|-------------|-------------|
| `chrome/extensions/aura_dns/manifest.json` | Added | Extension manifest with key |
| `chrome/extensions/aura_dns/service_worker.js` | Added | Extension service worker |
| `chrome/extensions/aura_dns/dns_fetcher.js` | Added | DoH TXT record fetcher |
| `chrome/extensions/aura_dns/icons/` | Added | Extension icons |
| `chrome/extensions/BUILD.gn` | Modified | Added `aura_dns` component_extension block |
| `chrome/browser/.../extension_ids.json` | Modified | Added KirinDNS Resolver entry |

---

## Extension Details

- **Name**: KirinDNS Resolver
- **Version**: 1.0.0
- **Manifest Version**: 3
- **Extension ID**: Derived from the public key in manifest.json
- **DoH Provider**: Cloudflare (https://1.1.1.1/dns-query)
- **Permissions**: webRequest, webRequestBlocking, storage,
  declarativeNetRequestWithHostAccess
- **Behavior**: Intercepts HTTP/HTTPS requests, resolves ADRP TXT records via
  DoH, redirects to non-standard ports if specified

---

## Compatibility

- Chromium version: 135.x (test and update for newer versions)
- Manifest V3: Fully compatible with Chromium's extension system
- No deprecated APIs used
- No platform-specific code

---

## Upgrade Path

When upgrading to a newer Chromium version:

1. Sync to the new version: `gclient sync --revision=refs/tags/NEW_VERSION`
2. Verify that the `BUILD.gn` syntax is still compatible (Chromium occasionally
   changes extension registration APIs)
3. Rebuild: `gn gen out/Default && ninja -C out/Default chrome`
4. Test that the extension loads correctly at `chrome://extensions/`

---

## License

The KirinDNS extension code is licensed under the MIT License.
All Chromium source code remains under the Chromium license (BSD-style).
No Chromium source code has been modified.
