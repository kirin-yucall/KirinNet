# KirinDNS Browser — Build Instructions

This document provides step-by-step instructions for building a custom Chromium
browser with the KirinDNS extension pre-installed and enabled by default.

**Strategy**: We do NOT modify Chromium's core DNS stack. Instead, we use
Chromium's built-in extension mechanism to bundle the KirinDNS extension as a
component extension that ships with the browser binary.

**Target Chromium Version**: Chromium 135 (use the current stable release
channel at the time of build).

---

## Prerequisites

- Linux (Ubuntu 22.04 or later recommended), Windows 10/11, or macOS 12+
- Minimum 100 GB free disk space (source + build artifacts)
- Minimum 32 GB RAM (64 GB recommended for faster builds)
- x86_64 architecture (ARM64 also supported but not covered in detail here)
- Git and standard build tools

---

## Step 1: Set Up depot_tools

[depot_tools](https://chromium.googlesource.com/chromium/tools/depot_tools) is
the toolchain used to manage Chromium source code and build configurations.

```bash
# Clone depot_tools
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git

# Add depot_tools to PATH (add to ~/.bashrc or ~/.zshrc for persistence)
export PATH="$(pwd)/depot_tools:$PATH"

# Verify
gclient --version
```

---

## Step 2: Checkout Chromium Source

```bash
# Create a directory for the Chromium source
mkdir chromium-src && cd chromium-src

# Fetch the Chromium source (this downloads ~50 GB)
fetch chromium

# Enter the source directory
cd src

# Sync to the desired Chromium version (e.g., 135.0.xxxxx.x)
# Check the latest version at https://www.chromium.org/getting-involved/dev-channel
gclient sync --revision=refs/tags/135.0.7049.0  # update revision as needed

# Initialize the build configuration
gn gen out/Default
```

This may take 30-60 minutes depending on network speed.

---

## Step 3: Prepare the KirinDNS Extension

Copy the extension directory into the Chromium source tree under
`chrome/extensions/aura_dns/`.

```bash
# From the KirinDNS project root:
cp -r 03_Browser_Extension src/chrome/extensions/aura_dns
```

### 3.1 Generate an Extension Key

Built-in extensions require a public key for identity. Generate a key pair:

```bash
# Use the Chromium extension key tool
cd src/chrome/extensions/aura_dns
python3 third_party/catapult/shared/extension_keygen.py
# This outputs a PEM-encoded public key, e.g.:
# MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...==
```

Add the key to `manifest.json`:

```json
{
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...==",
  "manifest_version": 3,
  "name": "KirinDNS Resolver",
  ...
}
```

### 3.2 Register the Extension as Built-In

Edit `src/chrome/extensions/BUILD.gn` to include the KirinDNS extension.

Find the `component_extension("aura_dns")` block (it does not exist yet) and
add it. The exact modification:

```gn
# In chrome/extensions/BUILD.gn, add a new component_extension block:

component_extension("aura_dns") {
  sources = [ "aura_dns/manifest.json" ]
  resources = [ "aura_dns/" ]
  deps = []
}
```

Then, in the same file, find the `"aura_dns"` entry in the
`component_extensions` list and ensure it is included:

```gn
# In the component_extension_deps or component_extension_ids list,
# add "aura_dns" if not already present.
```

For Chromium 135, the built-in extension registration also requires an entry in
`chrome/browser/resources/settings/extensions_page/extension_ids.json`. Add:

```json
{
  "name": "KirinDNS Resolver",
  "id": "<the-extension-id-derived-from-the-key>",
  "description": "Resolves KirinDNS (ADRP) TXT records via DNS-over-HTTPS",
  "built_in": true
}
```

The extension ID is derived from the key. You can find it after building by
checking the extension's `manifest.json` in the built binary, or by running:

```bash
# In a Chromium checkout, use the key-to-id utility
python3 tools/extension_id.py MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...==
# Outputs something like: abcdefghijklmnopqrstuvwxyz123456
```

### 3.3 Alternative: Load as Component Extension (Simpler Approach)

If modifying `BUILD.gn` is too invasive, you can install the extension as a
component extension at runtime:

```bash
# After building, install the extension into the user's profile
# Place the extension in the browser's component extensions directory:

# Linux:
mkdir -p ~/.config/chromium/ComponentUpdates/extensions
# Then create a component_update_url.json with the extension path

# Or simpler: use the --load-component-extension-from-file flag:
# chromium-browser --load-component-extension-from-file=/path/to/aura_dns.crx
```

However, the built-in approach (Section 3.2) is recommended for a true
"pre-installed" experience.

---

## Step 4: Build Chromium

### 4.1 Configure the Build

```bash
cd src

# Generate the build configuration with KirinDNS enabled
gn gen out/Default --args='\
  is_debug=false \
  is_component=false \
  symbol_level=1 \
  enable_nacl=false \
  enable_widevine=false \
  ffmpeg_branding="Chrome" \
  proprietary_codecs=true \
  use_official_stack=true \
'
```

**Build configuration notes:**

| Flag | Value | Reason |
|------|-------|--------|
| `is_debug` | `false` | Release build (smaller binary, faster) |
| `is_component` | `false` | Static linking (single binary, easier distribution) |
| `symbol_level` | `1` | Minimal symbols (for crash reporting only) |
| `enable_nacl` | `false` | NaCl is deprecated |
| `enable_widevine` | `false` | Not needed for KirinDNS |
| `ffmpeg_branding` | `"Chrome"` | Required for official Chrome builds |
| `proprietary_codecs` | `true` | H.264/MP3 support (optional, set `false` for Chromium branding) |

### 4.2 Run the Build

```bash
# Build with ninja (use -j to set parallelism, default is CPU count)
ninja -C out/Default chrome
```

**Build time estimates:**

| Hardware | Estimated Time |
|----------|----------------|
| 8-core CPU, 32 GB RAM | ~2 hours |
| 16-core CPU, 64 GB RAM | ~1 hour |
| 32-core CPU, 128 GB RAM | ~30 minutes |

### 4.3 Verify the Build

```bash
# Run the built browser
out/Default/chrome --version
# Expected output: KirinDNS Browser 135.0.xxxxx.x (Official Build) ...

# Check that the extension is loaded
out/Default/chrome --enable-logging --vmodule=extension_manager=1
# Look for "KirinDNS Resolver" in the log output
```

---

## Step 5: Build for Windows on Linux (Cross-Compilation)

```bash
cd src

# Generate a Windows build configuration
gn gen out/Default_win --args='\
  target_cpu="x64" \
  target_os="win" \
  is_debug=false \
  is_component=false \
  symbol_level=1 \
  enable_nacl=false \
  enable_widevine=false \
  ffmpeg_branding="Chrome" \
  proprietary_codecs=true \
  use_official_stack=true \
  use_sysroot=true \
'

# Install Windows cross-compilation sysroot
gclient sync --with_sysroot

# Build for Windows
ninja -C out/Default_win chrome
# Output: out/Default_win/chrome.exe
```

---

## Step 6: Package and Distribute

### 6.1 Create a Distribution Bundle (Linux)

```bash
# Create a distribution directory
mkdir -p kirindns-browser

# Copy the binary and dependencies
cp out/Default/chrome kirindns-browser/

# Copy the shared libraries (Chrome static build may not need this)
ldd out/Default/chrome | grep "=> /" | awk '{print $3}' | xargs -I {} cp {} kirindns-browser/ 2>/dev/null

# Copy resources
cp -r out/Default/chrome_*.pak kirindns-browser/ 2>/dev/null
cp -r out/Default/locales kirindns-browser/ 2>/dev/null

# Create a desktop entry
cat > kirindns-browser/kirindns-browser.desktop << 'EOF'
[Desktop Entry]
Name=KirinDNS Browser
Exec=/opt/kirindns-browser/chrome %U
Icon=kirindns-browser
Type=Application
MimeType=text/html;text/xml;application/xhtml+xml;x-scheme-handler/http;x-scheme-handler/https;
Categories=Network;WebBrowser;
Terminal=false
EOF

# Package as a tarball
tar czf kirindns-browser-135-linux-x86_64.tar.gz kirindns-browser/
```

### 6.2 Create an Installer (Optional)

For a more polished distribution, consider:

- **Linux**: Use [AppImage](https://appimage.org/) or [deb](https://www.debian.org/doc/debian-policy/)
- **Windows**: Use [NSIS](https://nsis.sourceforge.io/) or [Inno Setup](https://jrsoftware.org/isinfo.php)
- **macOS**: Use [create-dmg](https://github.com/create-dmg/create-dmg)

### 6.3 Branded Build Name

To change the browser name from "Chromium" to "KirinDNS Browser" in the title
bar and about page, add these flags to your `gn gen` args:

```gn
chrome_pak_version=0
chrome_pak_file="chrome.pak"
branding="KirinDNS"
```

Then copy the KirinDNS branding resources:

```bash
# Create branding directory
mkdir -p src/chrome/app/theme/chrome/KirinDNS

# Copy the default branding resources and customize them
cp -r src/chrome/app/theme/chrome/Chromium/* src/chrome/app/theme/chrome/KirinDNS/

# Replace the browser icon
# Place your 256x256 icon as:
# src/chrome/app/theme/chrome/KirinDNS/chrome_product_logo_256.png
```

---

## Troubleshooting

### "gn gen" fails with missing dependencies

```bash
# Re-sync with updated deps
gclient sync
```

### Out of memory during build

```bash
# Reduce parallelism
ninja -C out/Default chrome -j 4

# Or add a swap file
sudo fallocate -l 32G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```

### Extension not loading

Check the extension is registered:

```bash
# Open the built browser and navigate to:
# chrome://extensions/
# The KirinDNS Resolver should be listed and enabled
```

If the extension is not listed, verify:
1. The `BUILD.gn` entry exists in `chrome/extensions/BUILD.gn`
2. The extension ID is registered in `extension_ids.json`
3. The manifest key matches the extension ID
4. Re-run `gn gen out/Default` after making changes to BUILD.gn

### Build fails on Ubuntu 24.04+

Newer Ubuntu versions may have incompatible system libraries:

```bash
# Use Chromium's sysroot
export CC="clang"
export CXX="clang++"

# Or add the sysroot flag
gn gen out/Default --args='use_sysroot=true'
```

---

## Quick Reference: One-Command Build

For experienced Chromium developers, here's the condensed build flow:

```bash
# 1. Setup (first time only)
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git
export PATH="$(pwd)/depot_tools:$PATH"
mkdir chromium-src && cd chromium-src
fetch chromium && cd src

# 2. Add extension
cp -r /path/to/KirinDNS_Project/03_Browser_Extension chrome/extensions/aura_dns
# Add key to manifest.json
# Modify chrome/extensions/BUILD.gn (see Step 3.2)

# 3. Build
gn gen out/Default --args='is_debug=false is_component=false symbol_level=1'
ninja -C out/Default chrome

# 4. Run
out/Default/chrome --version
```
