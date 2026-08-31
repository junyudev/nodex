# Codex app-server runtime

Nodex embeds the unmodified, officially published Codex app-server package for
each supported macOS architecture. The canonical inputs and all expected
digests live in [`codex-app-server.lock.json`](codex-app-server.lock.json).

## Runtime authority

The lock identifies one exact `openai/codex` release by version, annotated tag,
peeled source commit, and official `codex-package_SHA256SUMS` asset. Each target
then binds the matching official `codex-app-server-package-*.tar.gz` URL, byte
length, archive SHA-256, app-server SHA-256, staged metadata SHA-256, target
triple, and package manifest.

Nodex does not patch or compile `codex-rs`, mirror the package into a second
release, or silently fall back to another runtime. A missing official full
package makes that Codex version ineligible for Nodex. A replaced or corrupted
asset fails its locked size or digest before extraction.

The current package closure is exactly:

- `codex-package.json`
- `bin/codex-app-server`
- `bin/codex-code-mode-host`
- `codex-path/rg`
- `codex-resources/zsh/bin/zsh`

The official package is signed by OpenAI before publication. Nodex checks the
complete archive independently, stages only the locked closure, and excludes
its four executable artifacts from Electron's nested-code signing pass. Release
packaging preserves the exact upstream bytes and OpenAI Developer ID signatures
while independently signing and notarizing the containing Nodex application.

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
4. requires the exact five-file package closure and canonical file modes;
5. validates package variant, version, target triple, entrypoint, architecture,
   and macOS compatibility;
6. records per-file hashes plus upstream release/source evidence in
   `agent-runtime.json`;
7. checks the staged metadata and entrypoint identities against the lock; and
8. admits Browser only when its manifest names this exact app-server/schema
   pair.

All bundled executables must match the requested architecture and support a
macOS deployment target no newer than Nodex's macOS 15 product minimum. An
upstream binary built for an older compatible macOS version is valid; the
bundled zsh currently establishes the effective macOS 15 floor.

Run the local runtime gates after staging:

```bash
vp run test:agent-runtime-conformance
vp run test:browser-runtime-conformance
```

On arm64, the macOS release gate also runs the Browser Computer Use probe. The
x64 package is staged and validated on arm64 CI, but executable conformance for
x64 must run on an Intel host or an equivalent trusted target runner.

## Upgrading Codex

Upgrade runtime provenance separately from protocol or product changes:

1. Select one reviewed `rust-v<version>` tag and verify its peeled source
   commit.
2. Require official arm64 and x64
   `codex-app-server-package-<target>.tar.gz` assets plus
   `codex-package_SHA256SUMS`.
3. Compare the checksum-manifest entry, GitHub asset digest, downloaded archive
   digest, and byte length for both targets.
4. Update a copy of the lock with the new upstream identity and official asset
   evidence.
5. Generate a candidate without mutating the canonical lock:

   ```bash
   vp run agent-runtime:relock -- \
     --base-lock /path/to/reviewed-base-lock.json \
     --arm64 /path/to/official-arm64.tar.gz \
     --x64 /path/to/official-x64.tar.gz \
     --out /path/to/candidate-lock.json
   ```

6. Review the derived entrypoint and staged metadata hashes, then install the
   candidate deliberately.
7. Regenerate the app-server protocol from the pinned official Codex CLI schema
   tool, review the schema diff, and update the Browser exact-pair manifest.
8. Stage and run the basic, multi-agent, handoff, and Browser conformance gates
   for both target packages before merging.

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
