# Changes not released yet

Each file here is one entry in the notes of the next Nodex release. When a release is published,
release automation adds its notes to [CHANGELOG.md](../CHANGELOG.md) and deletes the files it
published, so this directory always shows what has changed since the last release.

Every change is a file of its own, so branches that add changes at the same time never conflict.

## Add a change

Create `changes/<kind>/<YYYY-MM-DD>-<slug>.md`:

- `<kind>` is `added`, `changed`, `deprecated`, `removed`, `fixed` or `security`.
- `<YYYY-MM-DD>` is the day you write it. A release lists each kind's entries in file-name order,
  which keeps them in the order they were written.
- `<slug>` names the change in lowercase ASCII words joined by hyphens, such as
  `api-key-balances`. Use a different slug for each change in the release.

The file holds one entry and optional YAML front matter for media. Write the entry as one paragraph
without a leading `- `. Use inline Markdown like `**Settings > Agents**` for a place in the app or
`` `code` `` for something people type. Wrapped lines are joined with spaces.

`vp run release:check`, which `vp run check:changed` runs, checks every change.

## Write the entry

- Open with a sentence that stands on its own. The changelog page and What's new show it as the
  entry's lead and the rest as detail.
- Write for the people who use Nodex: what they can do now, or what no longer goes wrong. Leave
  out how the code changed.
- Write one change per file.

## Show the change

Give each Added and Changed entry a picture of what changed. The changelog page shows it with the
entry, the change gets a page of its own that people can share, and the release post starts from
it.

Take it from a seeded development instance with `vp run capture -- --hero <change file>`, which
shoots the feature in light and dark and attaches both; see
[Screenshots](../docs/development.md#screenshots). Show the finished state with realistic data,
frame the feature, and keep unrelated banners out. Pictures show the English interface; screenshots
are PNG and clips are MP4. To attach files you already have:

```bash
vp run media:add -- changes/changed/2026-11-26-example.md --caption "What the picture shows" --light light.png --dark dark.png
```

Pictures stay out of the repository. The change file names each one by its SHA-256 under `media`,
and the files wait in `notes.local/media/` until the release publishes them. A caption is one line
of plain text, and reusing a caption replaces that picture. Attach pictures before the Nightly you
promote: a release publishes what its source holds.

Only a release uploads pictures, and only those its change files still name, so drafts and
reshoots never leave the computer. `vp run media:prune` lists stored pictures that no worktree,
branch or tag mentions and that were stored more than 14 days ago; add `--delete` to remove them.

## Update or remove a change

- A follow-up to a change that has not been released edits that change's file instead of adding
  another, so a feature that has not shipped never collects its own Changed and Fixed entries.
- A change undone before it is released loses its file.
- When a rebase reports that a change file you edited was deleted, that change has been released.
  Leave it deleted, and write anything new your edit says as a new change.

## Headlines

A release's headline is written when the release is promoted, after reading the entries it will
publish. Changes carry no headline. See [Ship a stable release](../docs/release.md#ship-a-stable-release).
