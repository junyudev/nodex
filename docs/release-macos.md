# macOS Release Runbook

This document is the source of truth for Nodex application releases. A normal
release is expressed by a reviewed metadata-only commit on protected `main`;
there is no “Prepare Release” cloud form and no tag-push build path.

## Release model

The release system has one deep repository-owned Release Module under
`scripts/release/` and three thin GitHub Interfaces:

- `CI` proves source quality and exposes the stable required check
  `CI / required`.
- `Distribution Rehearsal` invokes the production Distribution Implementation
  without publishing anything.
- `Release` observes a successful protected-main CI run, recognizes an exact
  version transition, builds one verified Release Bundle, then promotes it.
- `Nightly Release` samples the exact green protected-main commit every three
  hours, skips stable metadata transitions and already-published identities,
  and publishes a prerelease plus only the Nightly feed subtree.
- `Release Recovery` is the only manual production recovery Interface. It
  accepts an exact source SHA and version and applies the same validation,
  Distribution, and promotion logic idempotently.

The important seam is the Release Bundle, not a YAML artifact convention.
Each native architecture emits an `architecture-build.json` that binds its
source commit/tree, Release Identity, runtime locks, prepared-build generation,
package provenance, official Agent Skills manifest/tree identity,
runner/toolchain versions, and artifact hashes. The assembler accepts both
manifests only when they describe one source and one Skill artifact, then emits:

- `Nodex-latest-arm64.dmg`
- `Nodex-latest-x64.dmg`
- versioned arm64/x64 full-update ZIPs
- signed arm64/x64 appcast snapshots and closed update manifests
- any architecture-qualified deltas the official Sparkle generator retained
- `release-identity.json`, identical across both architecture builds
- `release-bundle.json`
- `SHA256SUMS`
- `release-notes.md` for the publisher (not a public asset)

The tag is created only after this bundle passes. A published release is never
rebuilt in place, and an existing tag is never moved.

For each architecture, Distribution executes the stateful packaged runtime
smoke once against the extracted notarized ZIP App, including launch and the
symlinked CLI/Core/ripgrep workflow. The mounted DMG receives structural,
signature, notarization, and provenance verification only; matching sealed
provenance proves it contains the same App without repeating stateful smoke.
The launch check owns a verified isolated-run lease, so the extracted App does
not open the interactive move-to-Applications flow or mutate an installed copy.
Success requires the matching Electron host claim to reach full Main-runtime
readiness and the matching Core generation descriptor to exist. Startup has a
bounded CI deadline, captures bounded process and Profile logs on failure, and
terminates the complete Electron process group before releasing the lease.
Runtime-probe teardown uses bounded filesystem retries because a stopped macOS
Browser helper can briefly race recursive removal of its temporary Profile.
On arm64 macOS 15 or later, that probe must also complete a real Computer Use
tool call through the vendor-signed `Node -> Codex -> node_repl` ancestry, plus
the materialized plugin, private host-services socket, `sky.node`, and canonical
helper app. The primary app-server is the digest-pinned, unmodified package from
the locked official Codex release; Nodex neither rebuilds it nor publishes a
second copy.
The probe runner uses a temporary LaunchServices background app so helper stdio
matches an ordinary desktop launch instead of inheriting CI pipe fd guards.
The x64 probe must prove Computer Use is absent while Browser Use remains
available. Distribution runs this probe again against the extracted notarized
ZIP App's exact `Contents/Resources` closure with packaged native peer
authorization enabled; a successful staging probe cannot substitute for it.

## Release Identity

`package.json` remains the canonical source version. The Release Module derives
one exact-key Release Identity from the protected-main commit and passes that
artifact through every architecture, Sparkle finalizer, assembler, and
publisher. Stable keeps the source `x.y.z` as its display version. Both channels
encode the first-parent ordinal as a monotonic Apple build version (`842`
becomes `1.8.42`); Nightly derives its display version as
`x.y.(z+1)-nightly.YYYYMMDD.<first-parent-ordinal>`.
Workflow inputs and arbitrary environment variables cannot replace the
verified identity artifact.

Stable source metadata requires the same `x.y.z` value in:

- root `package.json`
- `[workspace.package].version` in `Cargo.toml`
- every local Nodex package entry in `Cargo.lock`
- the released Changelog heading
- prepared Electron metadata, app `Info.plist`, native runtime manifest, and
  the packaged `nodex --version` result

The only valid release commit diff is exactly:

```text
CHANGELOG.md
Cargo.lock
Cargo.toml
package.json
```

Ordinary source commits never rewrite those files for Nightly. A stable
metadata transition is owned only by `Release`; the Nightly resolver reports
`source-is-stable-transition` and exits successfully.

Any source, workflow, runtime lock, generated file, or second version change in
that commit makes release detection fail closed.

## One-time repository configuration

The repository must have these environments, restricted to protected `main`.
They separate deployment policy and audit. Reusable workflows receive only the
explicit repository-secret contract declared by their caller; protected
environment secrets are resolved only by direct jobs.

| Environment                 | Authority                                                             |
| --------------------------- | --------------------------------------------------------------------- |
| `macos-distribution`        | Apple signing/notarization; Sentry upload once from production arm64  |
| `sparkle-feed-finalization` | Sign appcasts and full/delta enclosures after both native builds pass |
| `release-publish`           | Job-scoped repository `contents: write` only                          |
| `official-skills-publish`   | Publish the verified artifact to `NodexApp/skills`                    |
| `homebrew-tap`              | Update and smoke-install `junyudev/homebrew-tap`                      |
| `landing-production`        | Deploy `NodexApp/NodexApp.github.io`                                  |

Configure these repository Action secrets:

| Secret                                                      | Required authority                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `CSC_LINK`, `CSC_KEY_PASSWORD`                              | Base64 Developer ID Application `.p12` certificate and its export password |
| `APPLE_API_KEY_B64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect notarization key                                         |
| `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`         | Release/source-map upload for the Nodex project                            |
| `NODEX_SKILLS_GITHUB_TOKEN`                                 | Fine-grained Contents read/write on `NodexApp/skills` only                 |
| `HOMEBREW_TAP_GITHUB_TOKEN`                                 | Fine-grained Contents read/write on `junyudev/homebrew-tap` only           |
| `NODEXAPP_GITHUB_IO_TOKEN`                                  | Fine-grained Contents read/write on `NodexApp/NodexApp.github.io` only     |

Configure `SPARKLE_ED25519_PRIVATE_KEY` as an environment secret on
`sparkle-feed-finalization`, not as a repository-wide secret and not as a
caller-supplied `workflow_call` secret. `Release`, `Distribution Rehearsal`, and
`Release Recovery` each own direct finalizer jobs bound to that environment and
pass the value only to the repository-local Sparkle finalization action. The
reusable native-distribution and Bundle-assembly workflows never declare or
receive the key. Repository guards reject reusable-workflow transport and any
reference outside a direct protected finalizer.

Each caller maps the repository secrets above to lowercase
`workflow_call.secrets` aliases. Do
not replace the mappings with broad `secrets: inherit`, and do not reference a
repository secret from PR CI. The Sparkle key is the deliberate exception: it
is resolved only by each top-level protected job and never crosses a reusable
workflow boundary. The alias boundary for all other credentials avoids relying
on implicit secret inheritance or same-name precedence inside nested reusable
workflows. Record PAT expiry dates in release operations and rotate them before
expiry. Remove duplicate credentials from the legacy `release` environment
after rehearsal succeeds.

The official Skills publisher authenticates Git through a GitHub-scoped Basic
extra header and keeps credentials out of remote URLs. Promotion additionally
configures `gh auth setup-git` as a workflow-owned recovery seam, so an
immutable older release source can still be republished without changing its
tag or checkout. Homebrew promotion registers `junyudev/tap` with `brew tap`
before style, audit, commit, and smoke-install; a plain clone outside Homebrew's
tap root is not a valid audit target. Promotion runs Homebrew's own cask
autocorrect inside that registered tap before its exact idempotency comparison,
so recovery can safely normalize derived output from an immutable older release
source without weakening version or checksum conflict rejection. It audits the
registered cask by its fully qualified tap name because current Homebrew rejects
file-path arguments to `brew audit`.

Distribution imports the Developer ID certificate into a per-job local
keychain using a random keychain password, grants non-interactive Apple tool
access with that keychain password, masks the generated password before any
security command can log it, and removes both the keychain and decoded
credentials in an `always()` cleanup step. Partial credential-file or job
environment setup failures use the same immediate cleanup boundary as
keychain failures. Command failures report only the failed Security.framework
operation, never its arguments. Electron Builder
discovers the installed identity but does not own credential import or
temporary-keychain creation.

If a release must intentionally omit Sentry source maps, change the production
workflow input to `false` in a reviewed foundation commit; do not silently
proceed with a partial Sentry configuration.

Repository Actions default permissions remain read-only. The `main` ruleset
requires PRs, linear history, an up-to-date branch, and `CI / required`; it
blocks force pushes and deletion. Repository merge settings enable rebase and
squash merges; release foundation batches and the single-commit metadata PR in
this runbook use rebase-and-merge so their reviewed commits remain a linear
`main` history. A `v*` tag ruleset prevents update/deletion while allowing the
release workflow to create a new tag. Immutable releases must be enabled after
the current Latest release points to a stable app release.

Every external Action is pinned to a full commit SHA. Dependabot proposes npm,
Cargo, and GitHub Action updates; high-authority Action changes require release
note and source review before merge. Dependency-only PRs update manifests and
lockfiles only: CI derives third-party notices and their build-resource
manifest in `.generated/build-resources/`, verifies two independent staging
builds, and does not ask the bot branch to commit generated output.
CI also classifies dependency-only changes as GitHub Actions, Rust, ordinary
JavaScript, or editor dependencies and maps them to explicit fail-closed gate
plans. Dependency changes select the complete deterministic source owners;
workflow orchestration selects its CI contracts and only the reusable owner it
changes. Main remains a targeted canary, while Nightly and release
certification own exhaustive source coverage. The exact four-file stable release transition is
the deliberate exception: its PR runs only the classifier and semantic release
transition guard; protected-main Main CI and the production Release workflow
still provide the post-merge canary, exact-source certificate, and
signed-distribution gates.

## Sparkle update signing and feeds

Sparkle 2.9.4 and its command-line tools are pinned by
`resources/sparkle/sparkle.lock.json`. Production apps carry the public key in
both their signed runtime identity and `Info.plist`. The stable feeds are:

```text
https://nodex.jyu.app/updates/stable/arm64/appcast.xml
https://nodex.jyu.app/updates/stable/x64/appcast.xml
```

The isolated Nightly feeds are:

```text
https://nodex.jyu.app/updates/nightly/arm64/appcast.xml
https://nodex.jyu.app/updates/nightly/x64/appcast.xml
```

GitHub Release is the immutable data plane for full ZIPs, deltas, update
manifests, and signed appcast snapshots. Stable releases are Latest; Nightly
releases are prereleases and never update Homebrew or official Agent Skills.
Stable site deploys replace only `updates/stable/`; Nightly publication stages
and commits only `updates/nightly/`, so neither channel can delete the other.
Every enclosure URL uses its exact tag; no feed
uses `/latest/download`. The finalizer accepts history only from an immutable
Release in the same channel whose tag resolves to the Release Bundle source SHA. Before it signs a
release, it proves the protected private key matches the reviewed public key
and that the extracted App plist/runtime carry that key; both architectures
must also use the pinned Developer ID Team ID `8HGUT3HC4Z`.

`Nightly Retention` keeps the newest 20 published Nightly releases and every
release younger than 14 days. It also protects every tag referenced by either
live Nightly appcast and deletes only immutable releases whose downloaded
Release Bundle index exactly matches the remote asset digests. A feed fetch or
Bundle verification failure fails closed. Scheduled runs are dry-run only.
Destructive mode is available only through manual dispatch and the protected
`nightly-retention` environment. Deleting an immutable Nightly release is
irreversible for recovery purposes; its identity and tag are never reused or
rebuilt in place.

The key was created with the official tool under Keychain account `NodexApp`.
These commands recover or inspect it without generating a second identity:

```bash
vp run materialize:sparkle:mac
.generated/sparkle-toolchain/2.9.4/bin/generate_keys --account NodexApp -p
.generated/sparkle-toolchain/2.9.4/bin/generate_keys --account NodexApp \
  -x /absolute/path/outside-the-repository/nodex-sparkle-private-key
```

Import an exported backup on a replacement release Mac with:

```bash
.generated/sparkle-toolchain/2.9.4/bin/generate_keys --account NodexApp \
  -f /absolute/path/to/nodex-sparkle-private-key
```

The repository owner may retain a mode-`0600`, gitignored convenience copy in
`secrets.local/secrets.md`; it is plaintext and does not replace the required
independent encrypted offline backup. To restore CI, pipe the key into the
environment secret without echoing it:

```bash
security find-generic-password \
  -a NodexApp -s https://sparkle-project.org -w \
  | gh secret set SPARKLE_ED25519_PRIVATE_KEY \
      --repo junyudev/nodex --env sparkle-feed-finalization
```

Never paste the private key into a workflow file, release artifact, command
argument, cache, appcast, issue, or log. If both Keychain and offline copies are
lost, stop ordinary feed publication and follow Sparkle's signed-feed recovery
procedure with a higher-version Developer ID signed and notarized recovery
image; do not upload an unsigned replacement ZIP or rewrite an immutable
release.

## Local gates

Use narrow checks while iterating. Before a release foundation or release
metadata PR is merged, run:

```bash
vp run verify:source
vp run verify:runtime:mac
```

`verify:source` is the platform-independent source gate: types, lint, generated
contracts, authority boundaries, build-resource and notices reproducibility,
Rust, app tests, browser tests, stress contracts, and landing build. Electron
E2E is an opt-in local diagnostic and is not part of source or release
certification. `verify:runtime:mac`
verifies Agent/Desktop Tool schemas and runtime conformance on macOS. Neither
proves Apple signing, Sparkle finalization, or Intel behavior; the
dual-architecture Distribution is that deeper Implementation.

Prepared Electron Main output must bundle source-only workspace packages. They
are build-time dependencies, not files for Electron's embedded Node runtime to
load from `app.asar/node_modules`; the prepared-build gate rejects any remaining
bare runtime load of such a package before packaging begins.

Every distribution first consumes an exact-source certificate produced without
signing secrets. The certificate binds the full commit SHA and Git tree to the
deterministic source, browser, stress, and macOS runtime gates. Distribution
verifies both identities before materializing credentials, carries the
certificate in each architecture bundle, and then runs the packaged
process/runtime probes.

The signed package gate must preserve the complete vendor signature closure
under `Contents/Resources/browser-runtime`, including the signed Codex CLI,
Node, Node REPL native dependencies, native PiP bridge, `sky.node`, and nested
Computer Use helper. Run deep strict `codesign` verification after restoring
that closure and resealing Nodex, then require Gatekeeper assessment,
notarization, stapling, and the architecture-specific runtime probe from the
extracted final ZIP. Do not replace the vendor teams with the outer Nodex team.

`vp run test:all` remains a compatibility alias for `verify:source`.

## Rehearse a candidate

Rehearse the exact protected-main foundation SHA before the first release after
release infrastructure or packaging changes:

```bash
gh workflow run release-rehearsal.yml \
  --repo junyudev/nodex \
  -f source_sha=<full-main-sha>
```

The secret-free `release-source` environment admits only a protected-branch
workflow definition. Inside that boundary, the shared provenance guard requires
the immutable SHA to be reachable from `main` and to have a successful
protected-main `Main CI` push run before any source checkout or execution. Both
hosted macOS architectures use the same source and signing environment.
Rehearsal also uses the protected Sparkle finalization environment, but it does
not receive `contents: write`, Homebrew/landing credentials, or a Sentry upload
token. It creates no tag, Release, tap commit, feed commit, or production
telemetry release.

Download `nodex-release-bundle-<sha>` and inspect `release-bundle.json` and
`SHA256SUMS`. A rehearsal is required after release workflow, native packaging,
Apple signing, updater, Agent runtime, Browser runtime, or provenance changes.

When a candidate consists of a large foundation batch, first land that batch
through an ordinary PR with rebase-and-merge while `package.json` still carries
the current released version. Wait for the resulting protected-main CI run,
then rehearse that exact final `main` SHA. Do not mix the next version transition
into the batch: the four-file metadata commit below must remain a separate,
reviewable release trigger.

## Prepare v0.2.1 (or another stable release)

Start from the latest protected `main`, use a dedicated branch, and provide the
version explicitly:

```bash
git switch main
git pull --ff-only origin main
git switch -c codex/release-v0.2.1
vp run release:prepare -- 0.2.1
```

The command requires a clean worktree, advances all version sources, and rolls
the meaningful `Unreleased` Changelog content into a dated `0.2.1` section. It
does not commit, tag, push, or publish.

Curate `CHANGELOG.md` for user impact; do not turn the commit log or internal
refactors into release notes. Then verify the transition:

```bash
vp run release:check -- --base origin/main --worktree
git diff -- package.json Cargo.toml Cargo.lock CHANGELOG.md
git diff --name-only
vp run verify:source
vp run verify:runtime:mac
```

The final path list must contain only the four Release Identity files. Commit
and open a PR:

```bash
git add package.json Cargo.toml Cargo.lock CHANGELOG.md
git commit -m "release: prepare v0.2.1" \
  -m "Synchronize the app and Rust workspace versions and roll the curated Unreleased notes into the v0.2.1 release entry."
git push -u origin codex/release-v0.2.1
```

Merge the single-commit PR with rebase-and-merge after `CI / required` succeeds.
Do not create a tag or manually dispatch the normal `Release` workflow. The
rebased commit must still be the exact four-file transition checked above; the
successful protected-main CI run on that commit is the release trigger.

## Automatic production path

The successful `Main CI` workflow for a main push wakes `Release` through
`workflow_run`. Before repository code or secrets are used, it validates the
triggering repository, `push` event, `main` branch, successful conclusion, and
source reachability. It checks the commit has one parent and asks the Release
Module to classify that parent-to-head transition.

Main CI runs may overlap so a newer source push does not add an entire CI run
to an older commit's queue. Release executions remain serialized by the
`release-main` concurrency group, and each execution validates and publishes
only its triggering Main CI source SHA.

An ordinary main commit returns `shouldRelease: false` and exits successfully.
A valid version transition runs this sequence:

1. Verify the remote stable app version and reject tag/source conflicts.
2. Certify the exact source SHA and Git tree through the full deterministic
   static, Rust, app, browser, stress, and macOS runtime gates without signing
   secrets.
3. Build, sign, notarize, launch, and inspect arm64 on `macos-26`, refusing a
   source tree that does not match the certificate.
4. Build, sign, notarize, launch, and inspect x64 on `macos-26-intel` under the
   same certificate.
5. On native macOS runners, fetch only compatible schema-2 release history,
   generate and round-trip deltas, normalize their architecture-qualified
   names, and sign the final appcasts and enclosures with the protected key.
6. Assemble and hash the exact Release Bundle with its source certificate on a
   clean Linux runner; obsolete blockmaps, `latest-mac.yml`, and
   `app-update.yml` are rejected.
7. Revalidate source, version, tag, remote state, and bundle identity.
8. Create or reuse an annotated tag targeting the exact source SHA.
9. Create/resume the GitHub draft, upload only the manifest allowlist, publish
   it as Latest, and verify immutability, asset digests, and tag target.
10. Regenerate the official Agent Skills from the exact source, require their
    manifest/tree hashes to match the Release Bundle, and atomically publish the
    same version to `NodexApp/skills` with an annotated tag.
11. Generate the Homebrew cask from the same bundle, audit it, push it, and
    smoke-install the published app. The generated DSL follows Homebrew's
    canonical stanza grouping and order and expresses the macOS 15 Sequoia
    minimum as `depends_on macos: :sequoia`.
12. Deploy the landing site from the same source SHA after release verification,
    preserving existing feeds on ordinary site deploys and atomically projecting
    the two signed snapshots on release deploys. Public feed bytes and every
    enclosure are checked after push.

Sentry source maps are uploaded only by the production arm64 build. Both builds
use `SENTRY_RELEASE=nodex@<version>` so the generated app identity agrees.

## Recovery

Use recovery only for a transient Distribution/publisher/downstream failure on
an already-reviewed release commit:

```bash
gh workflow run release-recovery.yml \
  --repo junyudev/nodex \
  -f source_sha=<full-release-main-sha> \
  -f version=0.2.1
```

Recovery repeats the `release-source` environment and shared protected-main
provenance guard, then requires that exact commit to be a valid metadata-only
transition for the supplied version. Its behavior is idempotent:

- absent tag/release: rebuild, verify, tag, publish;
- matching tag: reuse only when it resolves to the exact source SHA;
- matching draft: verify every existing asset digest, upload only missing
  assets, then publish;
- matching published release: verify it, then retry the independently
  idempotent Agent Skills, Homebrew, and landing/feed promotion jobs;
- retained cross-run artifacts are restored with `gh run download`, which owns
  GitHub's archive redirect and extraction behavior before bundle verification;
- matching Agent Skills tag and tree: reuse it; a conflicting tree or version
  rollback stops without moving the tag;
- conflicting tag or asset digest: stop without mutation.

Pages recovery always replays the signed snapshot already bound by the verified
Release Bundle. It never regenerates a delta or requires the signing key. The
projection refuses to move a newer feed backwards or replace the same version
with different bytes.

Never delete or replace a published immutable asset. A product or artifact
defect requires the next patch version. Deleting a bad draft is an explicit
manual destructive operation and must be investigated before recovery.

## Desktop Tool runtime releases and Latest

The separately sealed Desktop Tool runtime currently retains the
`browser-runtime` tag and command names for release compatibility, but it
contains Browser, native PiP, and architecture-optional Computer Use artifacts.
It must never become the app Latest release. Publish it only through:

```bash
vp run browser-runtime:publish -- \
  --repo junyudev/nodex \
  --tag browser-runtime-v<build> \
  --lock <reviewed-candidate-lock.json> \
  --arm64 <arm64-archive> \
  --x64 <x64-archive>
```

That Interface requires the reviewed release lock, proves both archives' names,
sizes, hashes, manifests, target architectures, and complete artifact closures,
then creates or resumes an exact draft, uploads only missing assets, publishes
only after creating against `--verify-tag`, forces `--latest=false`, and asserts
Latest is unchanged. Create and push the runtime tag at an exact reviewed Nodex
source commit first; do not use a bare `gh release create` for runtime releases.

The primary Agent runtime's canonical lock binds the official Codex tag and
peeled source commit, official checksum manifest, dual-architecture
`codex-app-server-package-*` bytes, legal evidence, stable upstream entrypoint
identity, staged metadata, and generated protocol schema. Nodex does not rebuild,
patch, republish, or re-sign Codex runtime assets: their exact bytes and OpenAI
Developer ID signatures remain intact. The locked app-server entrypoint digest
is the stable Browser compatibility identity; package signing and notarization
seal the containing Nodex application independently.

Generate upgrades from an explicit reviewed base lock and the two downloaded
official archives:

```bash
vp run agent-runtime:relock -- \
  --base-lock <base-lock.json> \
  --arm64 <official-arm64-archive> \
  --x64 <official-x64-archive> \
  --out <candidate-lock.json>
```

The candidate command verifies the official archive closure and derives the
entrypoint and staged-metadata identities. It never builds source, overwrites the
canonical lock, or publishes assets. Review and install the candidate
deliberately, then stage from an empty cache and run schema plus conformance
probes for both architectures. The complete lock, staging, and probe procedure is
owned by
[`resources/agent-runtime/README.md`](../resources/agent-runtime/README.md).

## Post-release acceptance

For v0.2.1, run:

```bash
gh release view v0.2.1 --repo junyudev/nodex \
  --json tagName,targetCommitish,isDraft,isImmutable,isPrerelease,assets,url
gh release verify v0.2.1 --repo junyudev/nodex
gh api repos/junyudev/nodex/releases/latest --jq .tag_name
gh release download v0.2.1 --repo junyudev/nodex \
  --pattern release-bundle.json --pattern SHA256SUMS \
  --dir .generated/v0.2.1-remote
vp run release:verify:remote -- \
  --repo junyudev/nodex \
  --bundle .generated/v0.2.1-remote/release-bundle.json
gh api repos/NodexApp/skills/git/ref/tags/v0.2.1 --jq .object.sha
curl --fail --silent https://nodex.jyu.app/updates/stable/arm64/appcast.xml \
  --output .generated/v0.2.1-remote/appcast-arm64.xml
curl --fail --silent https://nodex.jyu.app/updates/stable/x64/appcast.xml \
  --output .generated/v0.2.1-remote/appcast-x64.xml
```

The remote verifier needs only `release-bundle.json` and `SHA256SUMS` locally.
It reconstructs the exact asset allowlist from those files, then downloads every
published asset once into a temporary directory and verifies its byte length and
SHA-256 digest before removing the temporary copy.

The 0.2.1 baseline must contain zero deltas because 0.2.0 and earlier are not
compatible history. Also verify both stable DMG URLs, a clean Apple Silicon
install/first launch,
`nodex --version`, one Core-backed project operation, one Agent thread, one
Browser operation, a full-only update check from the 0.2.1 baseline,
Homebrew install/upgrade, and the
landing download selector. Confirm `npx skills@latest add NodexApp/skills`
discovers exactly the `nodex` Skill. `releases/latest` must be `v0.2.1`, never
a Browser runtime tag.

The next 0.2.2 rehearsal is the first incremental acceptance gate. It must use
the public 0.2.1 full ZIP for each architecture, record the emitted delta size,
prove `BinaryDelta apply` produces the exact 0.2.2 app, and exercise one real
installed update. Corrupt-delta/full-ZIP fallback and Intel installation remain
release-candidate/manual checks; a unit fixture alone is not sufficient
evidence.
