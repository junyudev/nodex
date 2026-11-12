# Browser runtime release

Nodex builds consume the Browser runtime exclusively through
`browser-runtime.lock.json`. Each target pins an immutable archive by byte size
and SHA-256, plus the manifest digest, source desktop build, Browser plugin
version and component versions. When Windows uses a separately published
closure, `windowsRelease` identifies the release and source build for both
Windows archives. Local Windows candidates have a null URL and
can be materialized from a local archive for worker verification. A null Windows
asset entry records that the target has no conformance-tested Browser runtime.
Nodex builds omit Browser and Computer Use on that target and keep the locked
Codex app-server. Runtime admission never infers compatibility from semver order or
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

1. Obtain the intended signed desktop build for each target.
2. For macOS arm64, run the following with the reviewed
   vendor compatibility metadata for that closure:

   ```sh
   vp run browser-runtime:vendor -- \
     --app <ChatGPT.app> \
     --codex-compatibility-version <version> \
     --target-arch arm64 \
     --out .generated/browser-runtime-vendor/<arch>
   ```

   For Windows, substitute `--windows-package <extracted MSIX directory>`
   for `--app` and select the matching architecture. Vendoring checks the package
   layout, BlockMap and embedded signer metadata without launching vendor code.
   Run native version, signature and app-server conformance checks on matching
   Windows workers.

3. Seal the prepared closure:

   ```sh
   vp run browser-runtime:archive -- \
     --source .generated/browser-runtime-vendor/<arch> \
     --out .generated/browser-runtime-release/<asset>.tar.gz
   ```

4. Record the local archive identity with a null URL. For publication, prepare
   a reviewed copy of the lock containing each approved archive's final
   immutable release URL. Give the publisher a candidate lock for that single
   release. Keep any separately published Windows pins in the build lock.
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

   Include `--win32-x64 <archive>` and `--win32-arm64 <archive>` for their
   respective conformance-tested targets. Set the whole Windows asset entry to
   null when no conformance-tested archive can be published.

   The publisher proves the local archive against that lock in a fresh temporary
   extraction, so shared runtime caches cannot substitute for upload verification.
   This includes exact name, size, digest, manifest, target architecture, and complete artifact
   closure. It creates or resumes a draft, rejects every unexpected or
   mismatched remote asset, uploads only missing archives, and publishes only
   after the draft is exact. It passes `--latest=false` throughout and verifies
   that GitHub Latest remains the stable Nodex app release. Never use a bare
   `gh release create` for a Browser runtime release.

7. Replace this lock atomically with the reviewed candidate only after the
   published assets have been downloaded and reverified.
8. Run the Browser runtime conformance test for the release artifact before
   publishing a Nodex release.

The vendor command requires an explicit source path. Normal builds select
locked release assets.
