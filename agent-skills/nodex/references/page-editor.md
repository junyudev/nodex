# Page editing and Files

Use actual IDs and validators returned by Nodex in place of the placeholders.
Consult leaf help for unfamiliar parameters; content discovery does not require
repeating the full capability and context workflow on every command.

## Find and read

```sh
nodex ls @PARENT_PAGE_ID
nodex tree @PARENT_PAGE_ID
nodex search 'launch plan'
nodex rg -n 'AUTH_EXPIRED'
nodex read @PAGE_ID
nodex --json read @PAGE_ID
nodex read --meta @PAGE_ID
nodex sed -n '1,80p' @PAGE_ID
nodex history @PAGE_ID
```

`ls` lists one layer; `tree` expands a bounded hierarchy. Search is ranked
Page-discovery evidence, while `rg` is exact content search. Neither search
snippets nor line windows are complete editable Page bodies. Follow declared
continuation for list/query windows. Resolve names or Page keys such as LAB-13
to returned stable IDs for writes and links.

## Direct edits

Append without creating a draft or temporary file:

```sh
nodex page insert @PAGE_ID <<'BODY'
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
*** Update Page: @PAGE_ID
@@
-Release date: Friday.
+Release date: Monday.
*** End Patch
PATCH
```

A missing or ambiguous old fragment requires reading and locating the target
again. It is not a reason to replace the whole Page.

```sh
nodex page rename @PAGE_ID 'Release checklist' --if-match TITLE_ETAG
nodex page create --parent @PARENT_PAGE_ID --title 'Release checklist' <<'BODY'
- Verify the package.
- Verify the rollback procedure.
BODY
```

Structured `read` returns title/body validators. Complete replacement uses
`page replace @PAGE_ID --if-match BODY_ETAG` with stdin or `--file` and a complete
body. Page deletion requires explicit user intent and `read --prepare page.delete`
followed by `page delete --if-match PAGE_ETAG`. Structural ownership cannot be
changed by deleting or fabricating owning shells in ordinary text edits.

For native Block edits, get the Block ID and its compatible ETag from the
appropriate representation. `block update --patch-json -` and
`block insert --block-json -` read typed JSON from stdin; the same flags accept
regular files. Their payload schemas are in machine help. Do not place an
inline JSON string where a file path is expected.

## Substantial rewrites

```sh
nodex draft create @PAGE_ID --output ./rewrite
# Edit ./rewrite/work/body.nested.md with normal file tools.
nodex draft diff ./rewrite
nodex draft apply ./rewrite
```

Keep the immutable base and manifest intact. A conflicting apply retains the
work directory for recovery. Wait before apply only when the user requested
review or the active policy requires it. Drafts own their retry identity.

## Page attachments and shared Files

Library owns Files. A Page may have entries at logical paths and independent
File references in its body. Paths organize attachments without creating Pages
or durable folders. List entries to obtain the current manifest revision:

```sh
nodex page file list @PAGE_ID
nodex page file put @PAGE_ID --path exports/summary.csv \
  --from ./summary.csv --if-manifest MANIFEST_REVISION
nodex page file read @PAGE_ID --path exports/summary.csv --output ./download.csv
nodex page file rename-path @PAGE_ID --file-id FILE_ID \
  --path reports/summary.csv --if-manifest MANIFEST_REVISION
nodex page file remove @PAGE_ID --file-id FILE_ID --if-manifest MANIFEST_REVISION
```

Removal detaches this entry; it retains the File and independent body uses.
`page file replace-entry` imports a new File and retargets only this entry;
`file replace` updates shared bytes for every use and requires direct File
permission, current File revision, and head version. They are different intents.

Use `file import --from PATH` for an independent Library File. Inspect direct
File metadata with `file info FILE_ID`, retained versions with
`file versions FILE_ID`, and restore with `file restore` using its declared
revision/head conditions. Binary reads can use raw stdout only when the caller
preserves bytes; explicit JSON downloads require `--output PATH`.

Keep disposable intermediates in the ordinary Agent workspace. To open a
result, use `nodex open page @PAGE_ID`; use `--print` to obtain its canonical
link without opening a window. A saved script is data until the user authorizes
execution under the Agent's ordinary execution policy.
