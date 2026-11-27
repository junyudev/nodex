# Standalone ripgrep

Nodex ships ripgrep for local workspace file-name search, workspace text search,
and the native CLI's read-only `rg` command. The same [release lock](ripgrep.lock.json)
pins the executable Nodex can install for SSH text search when the remote login
has no trusted ripgrep. The supported desktop targets are macOS arm64 and Windows
x64 and arm64. SSH fallback also covers macOS x64 and Linux x64/arm64.

To update the pin, use the official [ripgrep release assets](https://github.com/BurntSushi/ripgrep/releases).
Update the version and record each archive URL, size, SHA-256, and executable
member. Extract the executable and record its size and SHA-256. For each Windows
architecture, derive both the Node and ripgrep entries from the official assets:

```bash
vp exec tsx scripts/relock-windows-tools.ts arm64 /path/to/node.exe /path/to/SHASUMS256.txt /path/to/ripgrep.zip
```

Use `x64` with the x64 assets. Copy the emitted entries into their release locks.
Combine
`COPYING`, `LICENSE-MIT`, and `UNLICENSE` in that order with a newline between
files and LF line endings. Replace `LICENSE` and update its digest if it changed.

Inspect the macOS archive member with `codesign -dvvv`. Nodex re-signs the
upstream arm64 executable, which has an ad-hoc linker signature. Compute
`machOContentSha256` with `ripgrepMachOContentSha256` in
`src/main/platform/node/ripgrep-runtime-artifact.mjs`. Confirm the digest is
unchanged after re-signing a copy. Verification pins the Mach-O bytes preceding
the terminal signature, with the signing-related size fields normalized, and
checks the packaged signature independently. Windows preserves the full
upstream executable bytes and stages any required retail Visual C++ libraries
beside the executable through the desktop redistributable pipeline.

Run `vp exec tsx scripts/desktop-build.ts stage-ripgrep` on each desktop target
and run the staged binary with `--version`. Distribution checks verify the
resource directory, upstream or signed content, license, and installed
executability. The SSH installer verifies the raw archive and executable
before sending the executable to the remote host.
