# Codex app-server runtime

On Apple silicon, Nodex installs the unmodified official Codex CLI package
on first use as a Component. The Windows app carries the package in Resources.
The canonical inputs and expected digests live in [`codex-app-server.lock.json`](codex-app-server.lock.json).

## Runtime authority

The lock identifies one exact `openai/codex` release by version, annotated tag,
peeled source commit, and official `codex-package_SHA256SUMS` asset. Each target
then binds the matching official `codex-package-*.tar.gz` URL, byte
length, archive SHA-256, CLI entrypoint SHA-256, staged metadata SHA-256, target
triple, and package manifest. The same lock provides archive identities for managed
installations on macOS, Linux, and Windows; the installer derives its release
version and URLs directly from that authority. The lock is the tested list for
Nodex's own Codex. A release joins it when the lock pins that release.

On Apple silicon, on-first-use installation checks a bounded set of paths from
the login shell and known installation locations for a full package. It copies only
the locked inventory, screening file types and sizes before copying. The same
staging verifier used for downloads authenticates the copied files against the
pinned metadata digest. A complete match installs the Component without a download.

Nodex does not patch or compile `codex-rs`, mirror the package into a second
release, or silently fall back to another runtime. A missing official full
package makes that Codex version ineligible for Nodex. A replaced or corrupted
asset fails its locked size or digest before extraction.

The pinned CLI runs the native app-server command and supports daemon discovery without a second executable or an external PATH dependency. Local daemon selection is opt-in, requires an already-running compatible daemon, and is disabled when launch configuration overrides or managed Git require a dedicated process.

Every package includes these runtime entrypoints and resources:

- `codex-package.json`
- `bin/codex`
- `bin/codex-code-mode-host`
- `bin/codex-exec-server`
- `codex-path/rg`

The release lock also enumerates the complete voice runtime, shared libraries,
plugins, manifests, and license files supplied by that release. Staging requires
the exact locked inventory, including these resources.

OpenAI signs the official macOS package before publication. The Component
installer verifies the archive and locked closure, preserves OpenAI's bytes
and signatures, and adds the repository's Codex `LICENSE` and `NOTICE` files.
The archive includes its voice runtime notices and licenses. Nodex signs and
notarizes the application independently. macOS Distribution requires the
pinned upstream asset to remain downloadable at its recorded size and verifies
the package from those bytes. If the asset disappears, re-pin before releasing.

## Staging and validation

Stage the target selected for the current host:

```bash
vp run stage:codex-runtime:mac
```

Staging is fail-closed. It:

1. downloads or accepts the exact locked archive through the SHA-addressed
   immutable cache;
2. checks byte length and SHA-256 before extraction;
3. rejects absolute/traversal paths, symlinks, hard links, devices, and FIFOs;
4. requires the exact locked package closure and canonical file modes;
5. validates package variant, version, target triple, entrypoint, architecture,
   and macOS compatibility;
6. records per-file hashes plus upstream release/source evidence in
   `agent-runtime.json`;
7. checks the staged metadata and entrypoint identities against the lock; and
8. admits Browser only when its manifest names this exact app-server/schema
   pair.

All staged executables must match the requested architecture and support a
macOS deployment target no newer than Nodex's macOS 15 product minimum. An
upstream binary built for an older compatible macOS version is valid. Shell
execution uses the platform shell supplied by the host.

Run the local runtime gates after staging:

```bash
vp run test:agent-runtime-conformance
vp run test:browser-runtime-conformance
```

Development continues to stage `.generated/codex-runtime/agent-runtime` for
builds and conformance. macOS Distribution verifies Codex and runs the Browser
Computer Use probe against the notarized app and the materialized Components
in an isolated store.

## Standalone Node

The Agent Runtime and app-tools server run under the standalone Node pinned by
[`node-runtime.lock.json`](node-runtime.lock.json). macOS stages the executable
from the pinned official arm64 archive. Windows stages the pinned x64 Node
executable. Staging verifies the executable's digest and
architecture, includes the locked Node license, and records the executable
identity in `node-runtime.json`. The Agent Runtime's private PTY dependency
uses the same Node executable for its build or native load check.

Development reads `.generated/node-runtime/<platform>-<arch>`. Installed
apps read the platform-specific `Resources/node-runtime` directory. The macOS
package keeps the Node.js Developer ID signature and upstream executable
bytes intact. Desktop Tools carry their own Node for their Browser and
Computer Use processes.

## Upgrading Codex

Upgrade runtime provenance separately from protocol or product changes:

1. Select one reviewed `rust-v<version>` tag and verify its peeled source
   commit.
2. Require the official macOS arm64 package, the Linux arm64 and x64 and the
   Windows x64 and arm64 `codex-package-<target>.tar.gz` assets plus
   `codex-package_SHA256SUMS`.
3. Compare the checksum-manifest entry, GitHub asset digest, downloaded archive
   digest, and byte length for the macOS arm64 package; bind every managed
   installation archive to the same checksum manifest.
4. Update a copy of the lock with the new upstream identity and official asset
   evidence.
5. Generate a candidate without mutating the canonical lock:

   ```bash
   vp run agent-runtime:relock -- \
     --base-lock /path/to/reviewed-base-lock.json \
     --arm64 /path/to/official-arm64.tar.gz \
     --out /path/to/candidate-lock.json
   ```

   Use `--windows-x64` and `--windows-arm64` with their matching archives to derive
   the Windows pins.
   Each archive is checked against the reviewed checksum manifest, exact file
   inventory and native architecture before its metadata is recorded. Relocking
   also records the macOS archive's unpacked file bytes for the Component store. These
   options may also be used without `--arm64` to retain the current macOS pin.

6. Review the derived entrypoint and staged metadata hashes, then install the
   candidate deliberately.
7. Regenerate the app-server protocol from the pinned official Codex CLI schema
   tool, review the schema diff, and update the Browser exact-pair manifest.
8. Stage and run the basic, multi-agent, handoff, and Browser conformance gates
   for the macOS arm64 package before merging.
   Review the basic probe's model IDs and visible default, and verify that loaded
   Thread metadata agrees with its configured model and reasoning effort.

While establishing a new Browser pair, stage Codex alone through the staging
script's optional Browser input, then regenerate the protocol:

```bash
vp exec tsx scripts/stage-codex-runtime.ts --target-platform darwin --target-arch arm64 --out .generated/codex-runtime
vp exec tsx scripts/codex-schemas.ts generate
```

This leaves Browser admission unchanged. The complete runtime gates still require
the tested exact pair before merging.

Model availability belongs to the running app-server's `model/list` response.
For authenticated comparisons, use the same account and client initialization,
record the actual runtime versions, and allow the online catalog to refresh.
A disk cache can differ from a running process's catalog and is not sufficient
evidence of the models available in that process.

`agent-runtime:relock` never builds source, downloads an unreviewed replacement,
overwrites the canonical lock, or publishes assets. If a future release omits
any required official artifact, skip that release instead of reconstructing the
package locally.

## Reliability boundary

The app-server owns execution, agent mailboxes, and transcripts. Nodex owns its
durable Thread/subagent projection and user-visible recovery behavior. Runtime
validation covers ordinary spawn, follow-up, wait/list, interrupt, nested
direct-parent completion delivery, cleanup, and residency reload. Nodex tests
separately prove reconnect reconciliation, stale-generation fencing,
`active → done` convergence, and truthful unresolved presentation.

If a reproducible upstream runtime defect affects real work, first contribute a
fix and regression test upstream. A Nodex-private Codex fork is a last resort,
not an upgrade mechanism.

## Claude Code

On Apple silicon, Nodex installs its Claude Code executable on demand as a
Component for API key and Nodex credit connections. The app carries the Agent SDK
and fetches the SDK's matching native package from npm when those connections
need it. The Profile keeps the verified executable and its upstream license.
The Windows app carries the native package beside the SDK. A regular Claude
connection runs the person's configured Claude Code.

[The Claude Code lock](claude-code.lock.json) pins the SDK version, registry
archive, and executable. After updating the Agent SDK, run
`vp run claude-code:relock` to verify the registry tarball and record its size
and digests.
