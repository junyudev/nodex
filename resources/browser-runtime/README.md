# Browser runtime release

Nodex builds consume the Browser runtime exclusively through
`browser-runtime.lock.json`. Each architecture-specific archive is immutable and
bound by its byte size, archive SHA-256, inner manifest SHA-256, source desktop
build, Browser plugin version, vendor compatibility metadata, and component
versions. Runtime admission never infers compatibility from semver order or
requires the independently supplied Browser peer CLI and primary app-server to
have equal versions. Each architecture must instead match one exact,
conformance-tested app-server/Browser artifact identity committed in
`src/shared/browser-app-server-compatibility.mjs`; any untested combination
fails closed.

The sealed closure includes unprivileged Browser and Computer Use clients plus
their trusted Node REPL RPC services. Nodex enables only the named services for
capabilities available to a thread, resolves them from the verified closure,
and keeps service code inside the trusted runtime roots. Adding another trusted
service requires a new manifest contract and runtime review.

Normal development, CI, and packaging must use
`vp run materialize:browser-runtime:mac`. They must not inspect an installed
desktop application.

Updating the runtime is an explicit maintainer workflow:

1. Obtain the intended signed desktop builds for both macOS architectures.
2. Run the following separately for `arm64` and `x64`, preserving the reviewed
   vendor compatibility metadata for that closure:

   ```sh
   vp run browser-runtime:vendor -- \
     --app <ChatGPT.app> \
     --codex-compatibility-version <version> \
     --target-arch <arm64|x64> \
     --out .generated/browser-runtime-vendor/<arch>
   ```

3. Seal each prepared closure:

   ```sh
   vp run browser-runtime:archive -- \
     --source .generated/browser-runtime-vendor/<arch> \
     --out .generated/browser-runtime-release/<asset>.tar.gz
   ```

4. Prepare and review a candidate lock containing both archive identities and
   their final immutable release URLs. Keep it outside the production lock
   path until the remote release exists.
5. Create and push the dedicated annotated tag at the exact reviewed Nodex
   source commit chosen to own this runtime release. The guarded publisher
   requires the remote tag to exist and will not infer a target from a moving
   branch.
6. Publish both immutable archives only through the guarded publisher:

   ```sh
   vp run browser-runtime:publish -- \
     --repo junyudev/nodex \
     --tag browser-runtime-v<build> \
     --lock <reviewed-candidate-lock.json> \
     --arm64 .generated/browser-runtime-release/<arm64-asset>.tar.gz \
     --x64 .generated/browser-runtime-release/<x64-asset>.tar.gz
   ```

   The publisher proves both local archives against that lock, including exact
   name, size, digest, manifest, target architecture, and complete artifact
   closure. It creates or resumes a draft, rejects every unexpected or
   mismatched remote asset, uploads only missing archives, and publishes only
   after the draft is exact. It passes `--latest=false` throughout and verifies
   that GitHub Latest remains the stable Nodex app release. Never use a bare
   `gh release create` for a Browser runtime release.

7. Replace this lock atomically with the reviewed candidate only after the
   published assets have been downloaded and reverified.
8. Run the Browser runtime conformance test for both release artifacts before
   publishing a Nodex release.

The vendor command accepts an application path only when it is explicitly
provided. This keeps local application state outside the normal build contract.
