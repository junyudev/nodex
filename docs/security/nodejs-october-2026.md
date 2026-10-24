# October 2026 Node runtime assessment

Assessed on 2026-10-24 against main commit
`8f2ebc83c5b964c7a2c7727ae32640984a0b0ad5` and the published macOS arm64 v0.4.0 ZIP.
This change patches host tooling and npm-installed Undici. It does **not** certify
the desktop application as fully patched or establish remote code execution in Nodex.

## Runtime inventory

| Surface                                                                                            | Runtime before this change                                                                                    | Ownership and result                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contributor Vite+, pnpm, build scripts, host tests, landing build                                  | `.node-version`: 24.15.0; engines permitted it                                                                | Pin and minimum raised to 24.22.1. No Node major or product behavior change.                                                                                                                                                   |
| GitHub workflow shell commands                                                                     | Shared setup used 24.15.0; classification, final-gate and certification jobs also invoked runner-default Node | All repository `node` commands now use the shared setup and exact-version verification.                                                                                                                                        |
| JavaScript GitHub Actions themselves                                                               | Action/runner-managed executable                                                                              | Separate from shell PATH and `.node-version`; not inspected or patched by this change. Existing immutable Action refs remain.                                                                                                  |
| Electron Main and Electron test workers                                                            | Electron 44.4.4, Node 24.21.0                                                                                 | Confirmed by running the upstream Linux x64 binary; DNS/TLS regressions reproduced. Still requires an independently tested Electron update/backport.                                                                           |
| Supervised Agent Runtime and ACP helper processes                                                  | Signed Browser closure's Node 24.21.0                                                                         | `AgentRuntimeApplicationLive.ts` supplies `bundle.paths.node` to `AgentRuntimeEntrypoint.ts`. Ordinary development uses this too; only identified disposable tests admit an explicit host override. Not fixed by the host pin. |
| Browser/Computer Use RPC, Chrome native-host integration, template picker and workspace Node tools | Same Browser closure                                                                                          | `resources/browser-runtime/browser-runtime.lock.json`, release `browser-runtime-v26.1007.71326`. Requires a complete new signed closure and conformance review.                                                                |
| Core and shipped CLI                                                                               | Native Rust executables                                                                                       | Not Node applications. Rust TLS, compression and database dependencies have separate patch ownership.                                                                                                                          |
| Codex app-server and native Claude/OpenCode providers                                              | Independently supplied native distributions                                                                   | Neither host Node nor Electron's Node is their runtime. Their own embedded libraries require vendor-specific evidence.                                                                                                         |
| User-configured ACP Node, SSH execution hosts, terminal commands                                   | Explicit user/remote executable                                                                               | Not controlled by repository pins. Inventory and update each selected installation independently.                                                                                                                              |
| npm Undici                                                                                         | 6.29.0, 7.30.0, 8.11.2                                                                                        | Updated to 6.29.1, 7.30.1, 8.12.2 with vulnerable-range overrides and regenerated pnpm lockfile.                                                                                                                               |

`@types/node` describes TypeScript APIs and contains no Node executable. It is not
a security patch target here. No additional project-owned Docker, Render, Volta,
`.nvmrc`, or bundled standalone Node download pin was found. The workspace runtime
lock distributes Python, not another Node installation. Existing prepared-build
and Agent Runtime cache identities already include the actual host Node version;
prepared Electron builds also include `.node-version` among their inputs.

## Published artifact evidence

Downloaded [Nodex-0.4.0-arm64.zip](https://github.com/junyudev/nodex/releases/download/v0.4.0/Nodex-0.4.0-arm64.zip)
and verified its GitHub release asset SHA-256:

```text
b43b5f7af76578a289e2ed01123ec1aafa123200a0ee73588ac5d3d73772c711
```

Inside the actual archive:

- `Contents/Resources/prepared-electron-build.json` records host Node `v24.15.0`.
- Electron Framework's `Info.plist` records `CFBundleVersion=44.4.4`.
- `Contents/Resources/browser-runtime/browser-runtime-manifest.json` records Node
  `24.21.0`. Its SHA-256 matches the committed lock:
  `7970c6ac859db710949ad5cb0c3202eb5a1a3bac794f59be5511694a76f7d651`.
- The packaged `browser-runtime/bin/node` bytes match that manifest's SHA-256:
  `9d15ff36c0c6526429b426e77a0cc89b0717892723c3b4b8ea748d9c1fa287e0`.

Archive inspection on Linux does not execute the macOS application, verify
Gatekeeper/notarization, or prove the absence of vendor backports. The Electron
API probes below ran against the matching upstream Linux distribution, not the
macOS packaged executable.

## Affected versions versus reachable paths

The [Node announcement](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases)
and [24.22.1 release notes](https://nodejs.org/en/blog/release/v24.22.1/)
identify the patched 24.x release. They do not establish application exploitability.

| Advisory                                                                   | Nodex assessment                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CVE-2026-111497, Brotli decoder                                            | Agent `Runtime.ts` installs Effect's `FetchHttpClient`, which uses Node's global fetch. Remote response decoding can reach Node's Brotli decoder. A malicious/compromised endpoint must supply bytes to that decoder. No Nodex RCE demonstrated. |
| CVE-2026-105482, DNS NUL truncation                                        | No project hostname-allowlist flow into `dns.resolve*`/`reverse` identified. Vendored `HostProcess.ts` uses `dns.lookup` on the local hostname. Embedded Electron failed the safe NUL rejection probes.                                          |
| CVE-2026-105483, CVE-2026-106069, CVE-2026-106072, TLS hostname validation | Node TLS clients and configured endpoints require review for unusual IP spelling, trusted certificate material and platform resolver behavior. Electron's DNS-SAN rejection failures are API-level evidence, not an end-to-end exploit.          |
| CVE-2026-105481, HTTP keep-alive                                           | Requires Node HTTP Agent reuse and unsolicited peer data. Core's HTTP-over-UDS client is local; no external exploitation path demonstrated. Undici's dispatcher is a separate implementation.                                                    |
| CVE-2026-106074, startup snapshot entropy                                  | No application `--build-snapshot` or SEA `useSnapshot` workflow found. Electron/V8 startup snapshots are not automatically equivalent to the affected user-land mechanism.                                                                       |
| CVE-2026-106073, permission-model realpath                                 | Nodex does not use Node's permission model as its Agent isolation boundary. No matching bypass path identified.                                                                                                                                  |
| CVE-2026-106070 and CVE-2026-106071                                        | Officially Node 26-only issues; not applicable solely because these runtimes use Node 24.                                                                                                                                                        |

The Agent host listens on loopback using Effect's Node HTTP server. An Express /
body-parser transitive lockfile entry does not prove that Nodex exposes an Express
Brotli request-body handler. Conversely, being a desktop app does not eliminate
outbound response-decoding exposure. Browser image attachment uses
`contents.session.fetch`; Electron media and sandbox asset fetches also use its
Chromium networking adapters. Do not attribute those calls to Node's decoder
merely because the source is TypeScript in Main.

The npm Undici changes separately address
[content-encoding error handling](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c),
[EventSource memory limits](https://github.com/nodejs/undici/security/advisories/GHSA-4qv8-2p9j-2685),
and [integrity token normalization](https://github.com/nodejs/undici/security/advisories/GHSA-f72v-6w45-q472).
Consumers include Effect's Node platform, jsdom, Electron's downloader and node-gyp.
Updating these packages does not replace Brotli in any executable or change the
global fetch implementation built into Electron or the signed Browser Node.

## Verification and limits

- Official Linux x64 Node 24.22.1 archive SHA-256 verified; exact host check passed.
- All 14 offline DNS/TLS/Brotli probes passed under Node 24.22.1. Its Brotli version
  still reports `1.2.0`, illustrating why version strings alone miss backports.
- Electron 44.4.4 Linux x64 ZIP SHA-256 verified. Runtime reports Node 24.21.0,
  c-ares 1.34.8 and Undici 7.29.1. Of 14 probes, 11 failed: four DNS NUL checks,
  six numeric-DNS-SAN checks and the Brotli fix API marker. Missing the marker
  alone is not a memory-corruption exploit test.
- Host admission tests cover old releases, major changes, prereleases, engine
  drift, exact CI pins and Electron rejection. CI contract tests cover ambient
  `node` invocation and security-gate routing for a pin-only change.
  Running the guard with an actual Node 24.15.0 executable also rejects it.
- Real consumer-resolved Undici 6/7/8 tests pass for compressed fetch, valid and
  tampered mixed-case integrity tokens, and excessive encoding rejection. They
  use offline MockAgent responses, not the complete network-close exploit.
- Final focused selection: 89 tests passed across six files. Targeted lint and
  TypeScript checking of the changed production tooling passed. Workflow,
  matrix, protected-source and reusable-secret contract verifiers passed.
- Frozen-lockfile installation with lifecycle scripts disabled succeeded using
  managed Node 24.22.1 and pnpm 12.3.4. Agent Runtime bundling succeeded.
- Full native dependency installation encountered this container's `fchown`
  restriction while node-pty extracted headers. The full semantic command hit
  Vite+'s nested sandbox restriction; direct full `tsc-rs` was killed (exit 137).
  These are not successful full typecheck/native-build results.
- The broader 206-test tooling selection passed 205 tests; the existing icon
  baseline subprocess test failed because tsx CLI could not create its Unix IPC
  socket (`EPERM`). Focused changed-surface tests pass. macOS packaging, native
  signing, Electron UI and signed distribution rehearsal require a macOS runner.

The complete registry audit had 21 advisory entries before this change and 13
after; no Undici entries remain. Remaining entries cover stream-json, Electron,
DOMPurify, ip-address, Zod, body-parser and fast-uri. They are independent findings,
not suppressed or treated as fixed. The required dependency-security audit remains
red until they are resolved. See the PR for the final command results.

## Remaining release work

1. Obtain a complete patched Browser closure. No newer Browser runtime release
   was present in the repository at assessment time. Preserve vendor signatures,
   publish an immutable archive, update its lock and exact app-server compatibility
   tuple, then run Browser and Agent conformance plus signed macOS rehearsal.
   Swapping only `bin/node` would invalidate trust and is not a remediation.
2. Select an Electron release with explicit fixes/backport evidence and rerun
   the probes and native gates. The official [release index](https://releases.electronjs.org/releases.json)
   lists Node 24.22.0 for Electron 44.9.3 and 45.0.0, so a blind upgrade does not
   establish coverage. Electron also has a separate
   [compromised-CA mitigation](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9)
   fixed in 44.9.1; it must not be confused with the remaining Node fixes.
3. Rebuild, verify and publish new Nodex installers after those owners are fixed.
   Existing v0.4.0 downloads and installed apps are unchanged by this PR.
4. Audit selected external ACP/SSH/provider runtimes and runner-owned Action
   executables independently. Do not silently rewrite user installations or
   substitute a different runtime for an attested vendor process.
