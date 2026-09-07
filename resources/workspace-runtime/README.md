# Workspace document runtime

Nodex ships a managed Python installation and document libraries alongside the verified
Node runtime. `load_workspace_dependencies` returns their actual executable paths and
library versions. No system Python, user site-packages, or package installation is used
to satisfy this capability.

`workspace-runtime.lock.json` pins both macOS architectures, the Python archive, every
transitive wheel, download sizes and SHA-256 digests. Stage an architecture with
`vp run materialize:workspace-runtime:mac:arm64` or
`vp run materialize:workspace-runtime:mac:x64`. Downloads use the immutable artifact cache;
validated files are extracted into a private staging directory and atomically replace
`.generated/workspace-runtime/<arch>`. A staged manifest records the source lock digest
and every regular file. Python file aliases are materialized as regular files, so the
installation contains no symlink-dependent executable paths. Wheel command-line scripts
are retained as package data; only Python imports and the reported interpreter are public.

The macOS packaging tasks include this closure outside ASAR. The signing hook updates
file digests after signing Python and native extensions, before sealing the outer app.
Main verifies architecture, entrypoints, sizes and digests once on first use. Missing or
invalid bundles produce an explicit unavailable result. Use Python with `-I -B` to ignore
ambient import settings and avoid bytecode writes; this is import isolation, not a process
security sandbox. Write generated artifacts to the task workspace, never the runtime tree.

## Updating and verifying

Resolve wheel-only distributions for CPython 3.13 and both supported macOS architectures.
Keep each library version identical across architectures and retain its full transitive
closure. Fetch artifact URLs and hashes from the exact Python release and PyPI release
metadata, update the distribution ID and lock, and restage both architectures. Do not
replace a missing binary wheel with a local source build or omit a dependency silently.

Run each staged interpreter with `-I -B scripts/fixtures/workspace-runtime/documents.py
<disposable-output-directory>`. The probe writes and reopens Word, PowerPoint, spreadsheet
and PDF files and renders a PDF page to an image. Native MCP acceptance is covered by
`tests/e2e/nodex-app-tools-workspace-runtime.spec.ts`.

## Licenses and source

Python is the Astral python-build-standalone `20260901` distribution of CPython 3.13.15.
Its source release is [python-build-standalone 20260901](https://github.com/astral-sh/python-build-standalone/tree/20260901).
The notices in `python-licenses/` are copied unchanged from that release's license set
(commit `4bb01f09aaf362c71e891be4a41cb6d6ddf830b3`) and accompany the packaged runtime.
That upstream set includes notices for optional components beyond the selected archive.
CPython's own installed license and pip's bundled notices are retained as well.

Each wheel retains its `.dist-info` license files and any package-level third-party
notices, including native PDF, XML, image and cryptography dependencies. Exact wheel source
URLs and versions are in the lock. Node remains covered by the existing Browser runtime
distribution and its notices. Do not strip license directories while staging or packaging.
