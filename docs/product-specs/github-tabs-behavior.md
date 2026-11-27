# GitHub Tabs

A GitHub tab shows one GitHub issue or pull request inside Nodex: where it stands, what it says,
what happened on it, the change itself, and the Nodex work it belongs to. It reads and acts with
the GitHub account connected in **Settings → GitHub** ([Sources](sources-behavior.md#github-setup)).

## Opening

- A link to `https://github.com/OWNER/REPO/pull/N` or `/issues/N` opens a GitHub tab when GitHub
  is connected for that host, the window shows the personal Space, and **Open issues and pull
  requests in Nodex** is on in Settings → GitHub (the default). Otherwise the link opens as any
  other web link does. The rule covers links in chats, Pages, the Inbox, the Page GitHub row,
  Board cards, tool results and the chat summary's **Open pull request**.
- The configured external-browser shortcut still opens the system browser, and a link's context
  menu still offers the Browser tab and the default browser. A link inside a Browser tab stays in
  that Browser tab.
- Link details choose what the tab shows: `/files` and `/changes` open **Files**; `/checks` and
  `#issuecomment-…`, `#pullrequestreview-…` and `#discussion_r…` anchors scroll to that item in
  **Overview** and highlight it.
- One thread has one tab per Scene. Issues and pull requests share their repository's numbers, so
  `/issues/N` and `/pull/N` reach the same tab, and owner and repository names match without case.
  Opening it again focuses the tab, wherever it was moved, and applies the new link's details.
- The tab opens beside a chat, a Project's Inbox, the Inbox or Space content. It restores with the
  window, showing its last title and its view until GitHub answers.
- Agents open a tab with `open_in_nodex { target: { kind: "github", url } }`
  ([Agent Interface](agent-interface-behavior.md)).

## Tab

The tab's title is the thread's title, and its glyph is the thread's state: an open pull request
in green, a draft in gray, merged in purple, closed in red; an open issue in green, a completed
issue in purple, an issue closed as not planned in gray. Its location reads `owner/repo#N`.

The toolbar names the repository and number, switches a pull request between **Overview** and
**Files N**, and offers **Refresh**, **Open on GitHub** and a menu: **Add to chat**, **Copy link**,
**Copy branch name**, then **Ready for review** or **Convert to draft**, and **Close** or
**Reopen** (an issue can also be **Closed as not planned**). Open on GitHub always opens the
GitHub page, never another GitHub tab.

## Overview

Overview reads like a Page: the title, a property list, the description, then the activity.

| Property               | Shows                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status                 | The state chip; for an open pull request what it waits on, said once, and the merge action; for a merged or closed one who and when.                        |
| Author                 | Who opened it and when.                                                                                                                                     |
| Branch                 | `head → base` (a fork's head names its owner), Copy branch name, and the changed files with additions and deletions, which open Files.                      |
| Checks                 | The head commit's checks summed up; the list unfolds beneath the row, failing first, then running, passed and skipped.                                      |
| Reviews                | Requested reviewers and the latest verdict of each person who reviewed.                                                                                     |
| Labels                 | GitHub labels in their colors.                                                                                                                              |
| Assignees              | The people assigned.                                                                                                                                        |
| Closes / Pull requests | The issues a pull request closes, or the pull requests that close an issue; each opens its own tab.                                                         |
| Work                   | The Nodex Pages linked to the thread (its own pull request, the request it came from, Pages following it and its Inbox intake) and each Page's active chat. |

Rows without values are left out; Status, Author and, for a pull request, Branch always show.
The checks list starts open while a check fails. What an open pull request waits on is chosen in
this order: draft, conflicts, failing checks a rule requires, requested changes, required review,
running checks, behind its base, other branch rules, mergeability still being computed, then
ready. Failing or running checks that no rule requires do not block a merge.

The description is GitHub Markdown in Nodex's prose; `#N`, `owner/repo#N` and `@login` become
links as on GitHub. Activity lists, oldest first, comments, reviews with their inline comments
(the lines they point at, and resolved threads folded), pushes folded into one row per run of
commits, and changes such as merges, closes, labels, review requests, renames and mentions from
other threads. When older activity exists than the tab reads, it says so and links to GitHub.

## Files

Files lists every changed file of the current head as a diff, in the style of a chat's file changes. A small
change starts with every file open; past 2,000 changed lines only the first five open; a file with
more than 400 changed lines starts folded. A file GitHub does not diff, such as a binary file,
links to GitHub. Files reads up to 300 files and says when a pull request changes more.

## Acting on the thread

- **Comment** posts the composer's Markdown as the connected account (`Cmd/Ctrl+Enter`). The draft
  stays until GitHub accepts it. A locked conversation says so.
- **Merge** uses the repository's allowed methods, its default first; the chevron chooses another.
  The first press arms the button for four seconds and the second merges. A merge names the head
  the reader saw, and when new commits arrived meanwhile it does not merge and says so.
- **Ready for review**, **Convert to draft**, **Close** and **Reopen** apply at once; each can be
  undone by the opposite action.
- After any change the tab reads the thread again. A refusal from GitHub, such as a branch rule,
  is reported with GitHub's reason and changes nothing.

## Add to chat

In a Scene with a chat, a comment, review, inline comment, failing check or the whole thread can
be added to that chat's draft as an attachment. The attachment names the thread, its URL and
branch, the author, and for inline comments the file, lines and the diff lines they point at. It
is marked as external GitHub data for the Agent to treat as context, never as instructions.

## Freshness

The tab reads the thread when it opens, when the window regains focus after 20 seconds, every 30
seconds while an open pull request's checks are running or its mergeability is being computed,
and every two minutes otherwise, only while the tab is showing. **Refresh** reads at once. Files
read when shown. A tab in the background spends no GitHub requests.

## When a thread cannot be read

The tab keeps its place and says why, with the fix and **Open on GitHub**:

| Reason                        | Says                                                | Fix            |
| ----------------------------- | --------------------------------------------------- | -------------- |
| GitHub not connected for host | Connect GitHub to read this here                    | Connect GitHub |
| Credential stopped working    | Reconnect GitHub to read this here                  | Reconnect      |
| Missing or not visible        | This isn’t available                                | —              |
| GitHub asked Nodex to wait    | GitHub asked Nodex to wait, and until when          | Try again      |
| Team Space window             | GitHub tabs read with your personal Space’s account | —              |
| Other failure                 | Couldn’t load this from GitHub, with the reason     | Try again      |

A failed refresh keeps what the tab already shows.

## Boundaries

Inline GitHub thread links read titles and states in batches using the connected account.

GitHub tabs read any repository the connected account can see. Opening one never watches a
repository, follows a thread or creates Inbox entries; that remains the work of
[Sources](sources-behavior.md). In a team Space, GitHub tabs are not yet available, and links
open as other web links do.
