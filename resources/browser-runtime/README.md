# Browser runtime release

Nodex builds consume the Browser runtime exclusively through
`browser-runtime.lock.json`. The macOS arm64 archive is immutable and
bound by its byte size, archive SHA-256, inner manifest SHA-256, source desktop
build, Browser plugin version, vendor compatibility metadata, and component
versions. Runtime admission never infers compatibility from semver order or
requires the independently supplied Browser peer CLI and primary app-server to
have equal versions. The runtime must instead match one exact,
conformance-tested app-server/Browser artifact identity committed in
`src/shared/browser-app-server-compatibility.mjs`; any untested combination
fails closed.

Manifest producers, runtime decoders, and macOS packaging hooks share the schema
authority in `src/shared/browser-runtime-schema.mjs`. Packaging restoration and
signature resealing require the current schema; they reject older and unknown
schemas before modifying the runtime closure.

The sealed closure includes unprivileged Browser and Computer Use clients plus
their trusted Node REPL RPC services. Nodex enables only the named services for
capabilities available to a thread, resolves them from the verified closure,
and keeps service code inside the trusted runtime roots. Adding another trusted
service requires a new manifest contract and runtime review.

The Browser peer CLI retains its complete signed Codex package. Node REPL launches
through the package's signed native executable so native peer authorization can
verify its process ancestry. Computer Use imports `@oai/sky` through the trusted
RPC service; its plugin supplies the skill and has no separate client launcher.
The client and native helper share a short Profile-specific socket path, so they
cannot connect through another desktop application's ambient helper endpoint.

Normal development, CI, and packaging must use
`vp run materialize:browser-runtime:mac`. They must not inspect an installed
desktop application.

Updating the runtime is an explicit maintainer workflow:

1. Obtain the intended signed desktop builds for macOS arm64.
2. Run the following for `arm64`, preserving the reviewed
   vendor compatibility metadata for that closure:

   ```sh
   vp run browser-runtime:vendor -- \
     --app <ChatGPT.app> \
     --codex-compatibility-version <version> \
     --target-arch arm64 \
     --out .generated/browser-runtime-vendor/<arch>
   ```

3. Seal the prepared closure:

   ```sh
   vp run browser-runtime:archive -- \
     --source .generated/browser-runtime-vendor/<arch> \
     --out .generated/browser-runtime-release/<asset>.tar.gz
   ```

4. Prepare and review a candidate lock containing the archive identity and
   its final immutable release URL. Keep it outside the production lock
   path until the remote release exists.
5. Create and push the dedicated annotated tag at the exact reviewed Nodex
   source commit chosen to own this runtime release. The guarded publisher
   requires the remote tag to exist and will not infer a target from a moving
   branch.
6. Publish the immutable archive only through the guarded publisher:

   ```sh
   vp run browser-runtime:publish -- \
     --repo junyudev/nodex \
     --tag browser-runtime-v<build> \
     --lock <reviewed-candidate-lock.json> \
     --arm64 .generated/browser-runtime-release/<arm64-asset>.tar.gz
   ```

   The publisher proves the local archive against that lock, including exact
   name, size, digest, manifest, target architecture, and complete artifact
   closure. It creates or resumes a draft, rejects every unexpected or
   mismatched remote asset, uploads only missing archives, and publishes only
   after the draft is exact. It passes `--latest=false` throughout and verifies
   that GitHub Latest remains the stable Nodex app release. Never use a bare
   `gh release create` for a Browser runtime release.

7. Replace this lock atomically with the reviewed candidate only after the
   published assets have been downloaded and reverified.
8. Run the Browser runtime conformance test for the release artifact before
   publishing a Nodex release.

The vendor command accepts an application path only when it is explicitly
provided. This keeps local application state outside the normal build contract.
