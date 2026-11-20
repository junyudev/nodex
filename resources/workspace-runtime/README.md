# Workspace document runtime

On Apple silicon macOS, Nodex installs Document Tools in the Profile after an Agent first
calls `load_workspace_dependencies`. The tool returns the managed Node and Python executable
paths and document library versions. Use the returned Python with `-I -B` and write outputs
to the task workspace. The arguments isolate Python imports and prevent bytecode writes.

`workspace-runtime.lock.json` pins the upstream Python archive and every transitive wheel
by byte length and SHA-256. Its `release` section also pins the published Document Tools
archive, its manifest digest, and the unpacked byte count. Nodex checks the exact closure
before installing it into `<Profile>/components/document-tools/<archiveSha256>/`.

## Stage, sign, archive, publish, and pin

1. Update the source lock with the exact Python and wheel URLs, sizes and digests. Use wheel-only
   CPython 3.13 distributions for Apple silicon and retain the complete dependency and notice
   inventory. Give a changed set of source inputs or staging recipe a new distribution ID.
2. Run `vp run materialize:workspace-runtime:mac:arm64`. Staging populates
   `.generated/workspace-runtime/arm64` from the
   [shared runtime cache](../../docs/development.md#machine-local-artifact-cache). It keeps the
   interpreter and importable libraries, thins wheel binaries for Apple silicon, materializes
   retained aliases as regular files, and omits package installation and build tools. Review
   upstream layout changes if an expected prune path is missing. Development uses this staged
   directory.
3. Seal the release archive on Apple silicon:

   ```sh
   vp run workspace-runtime:archive -- --identity 'Developer ID Application: Name (TEAMID)'
   ```

   This signs every Mach-O with a secure timestamp and hardened runtime, verifies the signatures,
   reseals the manifest, and writes `nodex-workspace-runtime-<distributionId>-darwin-arm64.tar.gz`
   under `.generated/workspace-runtime-release`. The archive includes the Python and wheel notices.
   With `--notary-profile <profile>` or configured App Store Connect API credentials, the command
   submits the signed closure for notarization and reports the accepted submission ID.

4. Record the printed archive and manifest identities and byte counts in a candidate lock. A
   local candidate uses a null URL. For publication, set its URL to the GitHub release asset
   URL. Push the annotated `workspace-runtime-v<distributionId>` tag at the reviewed source
   commit already on the remote. Use an unused numeric suffix if the tag already exists.
5. Publish through the guarded publisher:

   ```sh
   vp run workspace-runtime:publish -- \
     --archive <archive-path> --lock <candidate-lock> --source-commit <full-source-sha>
   ```

   It verifies the archive against the lock in a fresh extraction, checks the annotated tag and
   immutable release setting, publishes the exact draft, and verifies that the stable app remains
   GitHub Latest.

6. Download the published asset, verify its SHA-256, and smoke the freshly extracted interpreter
   with `-I -B scripts/fixtures/workspace-runtime/documents.py <disposable-output-directory>`.
   Check strict signatures and a native extension import. Then pin the published asset in the
   build lock before releasing the app. Keep the archive publicly downloadable for as long as any
   supported app release pins it.

The document probe writes and reopens Word, PowerPoint, spreadsheet and PDF files and renders a
PDF page to an image. The native application tool is exercised by
`tests/e2e/nodex-app-tools-workspace-runtime.spec.ts`.

## Licenses and source

Python is the Astral python-build-standalone `20260901` distribution of CPython 3.13.15.
Its source release is [python-build-standalone 20260901](https://github.com/astral-sh/python-build-standalone/tree/20260901).
The notices in `python-licenses/` are copied unchanged from that release's license set
(commit `4bb01f09aaf362c71e891be4a41cb6d6ddf830b3`) and accompany the released runtime.
That upstream set includes notices for optional components beyond the selected archive.
CPython's own installed license is retained as well.

Each wheel retains its `.dist-info` license files and any package-level third-party
notices, including native PDF, XML, image and cryptography dependencies. Exact wheel source
URLs and versions are in the lock. The standalone Node distribution carries its own
license and is included in the app’s third-party notices. Keep license directories
when staging and archiving the workspace runtime.
