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
  `api-key-balances`.

The file holds the entry and nothing else: one paragraph of text, without a leading `- `. Inline
Markdown is fine: `**Settings > Agents**` for a place in the app, `` `code` `` for something people
type. Lines may wrap; they are joined with spaces.

`vp run release:check`, which `vp run check:changed` runs, checks every change.

## Write the entry

- Open with a sentence that stands on its own. The changelog page and What's new show it as the
  entry's lead and the rest as detail.
- Write for the people who use Nodex: what they can do now, or what no longer goes wrong. Leave
  out how the code changed.
- Write one change per file.

## Update or remove a change

- A follow-up to a change that has not been released edits that change's file instead of adding
  another, so a feature that has not shipped never collects its own Changed and Fixed entries.
- A change undone before it is released loses its file.
- When a rebase reports that a change file you edited was deleted, that change has been released.
  Leave it deleted, and write anything new your edit says as a new change.

## Headlines

A release's headline is written when the release is promoted, after reading the entries it will
publish. Changes carry no headline. See [Ship a stable release](../docs/release.md#ship-a-stable-release).
