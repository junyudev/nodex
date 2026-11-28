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
**Files N**, and offers **Review** (on an open pull request the viewer can comment on, or whenever
they have a pending review, with its pending comment count), **Refresh**, **Open on GitHub** and a
menu: **Add to chat**, **Add N open comments to chat** and **Add N failing checks to chat** when
there are any, **Copy link**, **Copy branch name**, then **Ready for review** or **Convert to
draft**, and **Close** or **Reopen** (an issue can also be **Closed as not planned**). Open on
GitHub always opens the GitHub page, never another GitHub tab.

## Overview

Overview reads like a Page: the title, a property list, the description, then the activity. A
person GitHub lets change them edits the title in place, as a Page title (Enter or leaving it
saves, Escape puts it back), and the description with **Edit description**, or **Add a
description** when there is none.

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
links as on GitHub. Activity lists, oldest first, comments, reviews with the conversations they
opened, pushes folded into one row per run of commits, and changes such as merges, closes, labels,
review requests, renames and mentions from other threads. When older activity exists than the tab
reads, it says so and links to GitHub. Its menu shows **All activity**, **Comments** (comments and
reviews only) or **Comments from people** (without bots); the choice is kept for every GitHub tab.

A review conversation lists its replies under its first comment, wherever they were written; a
review that only replied elsewhere is not repeated. A conversation names its file and lines and
shows them, says when it is outdated, and offers **Reply** and **Resolve** or **Reopen** to those
GitHub lets. Resolved conversations fold to one line, and several resolved ones of a review to one
row. A comment or review body taller than the fold shows its start under a fade with **Show
more**; opening a `<details>` inside it unfolds it.

The description, comments, reviews and review comments show their reactions with counts, the
viewer's own pressed; pressing one adds or removes the viewer's, and the picker offers GitHub's
eight. A comment's menu offers **Copy link**, **Open on GitHub**, and **Edit** or **Delete** when
GitHub allows the viewer; deleting asks once in place. A review's words can be edited, not deleted.

## Files

Files lists every changed file of the current head as a diff, in the style of a chat's file
changes. A small change starts with every file open; past 2,000 changed lines only the first five
open; a file with more than 400 changed lines starts folded. A file GitHub does not diff, such as a
binary file, links to GitHub. Files reads up to 300 files and says when a pull request changes
more.

When the tab is wide enough, a tree of the changed files sits beside the diffs, with a filter and
each file's open comment count; choosing a file opens and scrolls to it. The tree's toggle is kept
for every GitHub tab.

Each file carries the viewer's **Viewed** mark, kept by GitHub and so shared with github.com.
Marking a file viewed folds it, and a viewed file starts folded; a file that changed after it was
marked reads **Changed since viewed**. The summary counts the viewed files.

Review conversations sit at the lines they discuss (outdated ones read in Overview), and
conversations on a whole file sit above its diff. On an open pull request, the plus beside a line,
or a drag across line numbers, starts a comment on those lines: **Comment** posts it at once, and
**Start review** keeps it private in a pending review. While the viewer has a pending review, new
comments and replies join it with **Add to review**, as GitHub requires.

## Acting on the thread

- **Comment** posts the composer's Markdown as the connected account (`Cmd/Ctrl+Enter`). The draft
  stays until GitHub accepts it. A locked conversation says so.
- **Merge** uses the repository's allowed methods, its default first; the chevron chooses another.
  The first press arms the button for four seconds and the second merges. A merge names the head
  the reader saw, and when new commits arrived meanwhile it does not merge and says so.
- While GitHub still waits on checks or reviews and the viewer may enable auto-merge, the button
  reads **Merge when ready** (or its squash and rebase forms) and turns auto-merge on at once.
  Status then reads **Merges when ready** with **Cancel auto-merge**; a pull request in the merge
  queue reads **Queued to merge**.
- **Review** submits **Comment**, **Approve** or **Request changes** with a summary. Requesting
  changes needs words, and so does a comment review with no pending comments; an approval does
  not. The author, a draft and a closed pull request offer only Comment. A pending review is
  submitted as it is, its comments included, or discarded with **Discard review** after one
  confirmation. A review or line comment names the head the reader saw: when new commits arrived
  it does not apply and says so, and when the pending review changed elsewhere it says so too.
- A reply, resolution, reaction, viewed mark, edit or deletion shows at once and is taken back,
  with GitHub's reason, if GitHub refuses it. Text being written stays until GitHub accepts it.
- **Ready for review**, **Convert to draft**, **Close** and **Reopen** apply at once; each can be
  undone by the opposite action.
- After any change the tab reads the thread again. A refusal from GitHub, such as a branch rule,
  is reported with GitHub's reason and changes nothing.

## Add to chat

In a Scene with a chat, a comment, review, review conversation, failing check or the whole thread
can be added to that chat's draft as an attachment, and so can every open conversation or every
failing check at once, for an Agent to address together. The attachment names the thread, its URL,
branch and head, the author, and for conversations the file, lines, the diff lines they point at
and every reply. It is marked as external GitHub data for the Agent to treat as context, never as
instructions.

## Freshness

The tab reads the thread when it opens, when the window regains focus after 20 seconds, every 30
seconds while an open pull request's checks are running or its mergeability is being computed,
and every two minutes otherwise, only while the tab is showing. **Refresh** reads at once. Files
read when shown and again for a new head; a viewed mark updates them in place. A tab in the
background spends no GitHub requests.

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
