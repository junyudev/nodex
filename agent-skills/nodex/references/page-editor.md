# Page editing and Files

Use actual IDs and validators returned by Nodex in place of the placeholders.
Consult leaf help for unfamiliar parameters; content discovery does not require
repeating the full capability and context workflow on every command.

## Find and read

```sh
nodex sql query 'SELECT page_id,title FROM pages WHERE title LIKE :title' --param 'title="%launch%"'
nodex sql query 'SELECT page_id,nested_markdown,body_etag FROM page_documents WHERE page_id=:id' --param 'id="PAGE_ID"'
nodex sql query 'SELECT title,title_etag,file_manifest_revision,intrinsic_properties FROM pages WHERE page_id=:id' --param 'id="PAGE_ID"'
```

Use the SQL reference for filtering multiple bodies or joining Source values.
`read PAGE_ID` is a convenient single-Page text read; `--json read` returns content
with validators, and `read --meta` returns canonical metadata. `search` gives
ranked discovery evidence; `rg` serves exact regex workflows. Neither snippets
nor `sed` line slices are complete editing baselines. `ls`, `tree` and `history`
remain terminal conveniences with their declared bounds/continuations.
Resolve names or Page keys to stable IDs before writes and links.

## Direct edits

Append without creating a draft or temporary file:

```sh
nodex page insert PAGE_ID <<'BODY'
## Next steps

- Finish the release checks.
BODY
```

Use `--at start`, `before:BLOCK_ID`, `after:BLOCK_ID`,
`inside-start:BLOCK_ID`, or `inside-end:BLOCK_ID` for explicit placement.

For a precise text edit, copy the exact old fragment from the read result,
including any Nested Markdown identity markers, and supply enough context to
identify it uniquely:

```sh
nodex patch <<'PATCH'
*** Begin Patch
*** Update Page: PAGE_ID
@@
-Release date: Friday.
+Release date: Monday.
*** End Patch
PATCH
```

A missing or ambiguous old fragment requires reading and locating the target
again. It is not a reason to replace the whole Page.

```sh
nodex page rename PAGE_ID 'Release checklist' --if-match TITLE_ETAG
nodex page create --parent PARENT_PAGE_ID --title 'Release checklist' <<'BODY'
- Verify the package.
- Verify the rollback procedure.
BODY
```

SQL returns `title_etag`/`body_etag`; structured `read` also returns those validators. Complete replacement uses
`page replace PAGE_ID --if-match BODY_ETAG` with stdin or `--file` and a complete
body. Page deletion requires explicit user intent and
`page prepare PAGE_ID --operation delete`, followed by
`page delete PAGE_ID --if-match PAGE_ETAG` using `validators.page_etag`. Structural ownership cannot be
changed by deleting or fabricating owning shells in ordinary text edits.

For native Block edits, get the Block ID and its compatible ETag from the
appropriate representation. `block update --patch-json -` and
`block insert --block-json -` read typed JSON from stdin; the same flags accept
regular files. Their payload schemas are available with `--help-schema input`. Do not place an
inline JSON string where a file path is expected.

## Substantial rewrites

```sh
nodex draft create PAGE_ID --output ./rewrite
# Edit ./rewrite/work/body.nested.md with normal file tools.
nodex draft diff ./rewrite
nodex draft apply ./rewrite
```

Edit only the work files; keep the immutable base (including Block identity
correspondence) and manifest intact. Apply preserves unaffected Block identities
and safely corresponding edits. It never falls back to whole-body replacement.
Conflicting, ambiguous or oversized changes fail atomically and retain work files;
read current content and reassess, or use explicit Block operations for structure
that Markdown cannot express safely. Use `page replace` only when complete body
replacement is intended, never merely to get past a failed draft.

`draft diff` compares local files, not current applicability. Retry unchanged
pending work with the same draft; drafts own their retry identity. Wait before
apply only when the user requested review or the active policy requires it.

## Page attachments and shared Files

Library owns Files. A Page may have entries at logical paths and independent
File references in its body. Paths organize attachments without creating Pages
or durable folders. Read the Page manifest revision even when there are no File uses:

```sh
nodex sql query 'SELECT file_manifest_revision FROM pages WHERE page_id=:id' --param 'id="PAGE_ID"'
nodex sql query 'SELECT file_id,path,default_name,mime_type,byte_length FROM page_files WHERE page_id=:id' --param 'id="PAGE_ID"'
nodex page file put PAGE_ID --path exports/summary.csv \
  --from ./summary.csv --if-manifest MANIFEST_REVISION
nodex page file read PAGE_ID --path exports/summary.csv --output ./download.csv
nodex page file rename-path PAGE_ID --file-id FILE_ID \
  --path reports/summary.csv --if-manifest MANIFEST_REVISION
nodex page file remove PAGE_ID --file-id FILE_ID --if-manifest MANIFEST_REVISION
```

Removal detaches this entry; it retains the File and independent body uses.
`page file replace-entry` imports a new File and retargets only this entry;
`file replace` updates shared bytes for every use and requires direct File
permission, current File revision, and head version. They are different intents.

Use `file import --from PATH` for an independent Library File. Inspect direct
File metadata with `SELECT revision,head_version FROM files WHERE file_id=:id`,
retained versions through `file_versions`, and restore with `file restore` using
the observed revision/head conditions. Page authority does not grant independent
File history or shared writes. Binary reads can use raw stdout only when the caller
preserves bytes; explicit JSON downloads require `--output PATH`.

Keep disposable intermediates in the ordinary Agent workspace. To open a
result, use `nodex open page PAGE_ID`; use `--print` to obtain its canonical
link without opening a window. A saved script is data until the user authorizes
execution under the Agent's ordinary execution policy.
