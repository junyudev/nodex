# Agents Tab Behavior

Status: Active
Last Updated: 2026-11-25

## Intent

Running many chats at once, each delegating to subagents that delegate again, leaves no single
place that answers what all of that work is doing right now. The sidebar shows each chat, the
Inbox what needs the person, Activity what already happened and the Board the work itself. The
Agents tab shows the work in motion: every chat with live work in its scope, the whole tree of
subagents under it, and how each part stands.

It is an ordinary tab, so it can stay open beside the Inbox or beside a chat while the person
works elsewhere. It reads; it never becomes a second Inbox. Questions and approvals are answered
where they already are, in the chat or the Inbox.

Main composes the view from live Session activity, the Runtime's subagent overviews and Core's
Session placement; see [Agent Runtime behavior](agent-runtime-behavior.md#session-activity). The
renderer lays it out with the same map a chat's Subagents tab draws.

## Opening and placement

- The tab is the `agents` surface. A Scene holds at most one; opening it again selects the one
  already open, with the scope it keeps.
- It opens in the Library Inbox Scene, a Project Scene and a chat's content or bottom panel, never
  in Space.
- **Agents** in an Inbox's header, beside the Board button, opens it in the group to the Inbox's
  right, creating that split, so the Inbox and the Agents tab show side by side. A chat's
  Subagents map offers **All agents**, which opens it beside that chat. The command palette and
  the panel's new-tab menus offer it too.
- Its scope is one Project, or every Project together with chats that belong to none. It starts
  as the place it opened from: a Project Scene's Project, every Project from the Library Inbox,
  and a chat's Project, or every Project for a chat without one. The picker at the top of the tab
  changes it, and the tab keeps the choice.
- The tab's glyph says how work in scope stands, as a chat's own tab does: the question bubble
  while a chat waits on its person, a spinner while any chat works, and the map's glyph otherwise.
  It keeps saying so while another tab is selected.

## What it shows

**Active** lists every chat with live work in scope: working, waiting on its person, queued for
the Runtime, or running background work. Side chats and Nodex's own conversation are not listed;
archived chats never are.

Chats keep the order their current work started in. Moving between working, waiting, queued and
background never moves a chat, so a view kept in sight does not jump as work changes; a chat
leaves Active only when its work ends, and returns at the end of the list when new work starts.

Each chat is one band. Its lead card sits on the left with:

- the Agent's mark and name, and how its work stands: elapsed time while it works, `Needs
  approval` or `Needs your answer` in the attention tone while it waits on its person,
  `Queued · #n` while it waits for the Runtime, or `Background`;
- the chat's title;
- one line about the work: the request waiting on the person, else the Run's opening statement,
  else its background work;
- its model and effort, and how many of its subagents have reported back.

Every subagent the chat delegated to sits on the right, and the subagents those delegated to step
in beneath them, exactly as in the chat's own Subagents map: the same cards, the same order, the
same harness-colored lines that flow while work runs, hold still while it waits, turn solid when a
result returns and fade when work fails or is stopped. A band draws the first page of a chat's
subagents; one control above them says how many more the chat holds and opens the chat. A chat
without subagents is its lead card alone.

Above a band, a quiet line names the chat's Project while every Project shares the view, the work
Page it is the active chat of, and the Nodex mark when Nodex watches it.

**Recent** lists the chats whose work ended in the last 24 hours, newest first, ten at a time with
**Show more**: the Agent's mark, the title, a dot while its result is unread, how many subagents
it had, its Project while every Project shares the view, and when it ended, with `Failed` or
`Stopped` when it did not finish.

With nothing active or recent, the tab says that no Agent is working and that chats appear there
while their Agents work.

## Acting from it

- A lead card or a Recent row opens its chat. In a Project Scene the chat opens in the Project's
  Agent Dock, so the tab stays in place and the person can read and reply below it; anywhere else
  the window goes to the chat.
- A subagent's card opens that subagent beside its chat, as its row in the chat's Subagents tab
  does, and offers Stop while it is live and the reader may stop it.

## Live updates

While the tab shows, it follows live work and its clocks tick; while it is hidden it stops
following and holds its lines still, and catches up when it shows again. The glyph alone keeps
following while hidden. A view that cannot hold every live chat says so below the list.
