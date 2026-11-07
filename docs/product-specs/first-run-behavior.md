# First-Run Behavior

## Promise

Opening Nodex on a new Profile takes a person from nothing to an Agent working on their real code,
in about a minute, without creating anything they didn't choose. The first thing they see tells
them what Nodex already found on their computer, and the last thing they see is the real Workbench
with useful work ready to send.

Setup asks only what Nodex can't work out. It never stands between a person and the Workbench:
every page can be skipped, and everything it offers stays available afterward.

## When it opens

A Profile is fresh when its Library holds no Project, active or archived, no Session and no Page. Core
answers that question; the renderer records when setup has finished. The first window of a fresh
Profile opens on setup. A Profile that already holds work never does, however that work got there,
including a restored backup or a Profile prepared through the CLI. If either read fails, the
Workbench opens, so a broken read can never trap anyone in setup.

Quitting part-way resumes at the same step on the next launch, even though an earlier step may have
created Projects. Setup state is per Profile and synchronizes across windows: finishing in one
window closes it in the others.

`Run setup again` in Settings → General and in the command palette replays the same flow. Agents
and Projects that are already connected appear as such, and nothing is created or changed unless the
person chooses it. Finishing a replay stays where the person was, unless they added a Project.

## Presentation

Setup is a state of the real application window, following
[Desktop Startup Behavior](desktop-startup-behavior.md): the startup mark gives way to the first page
with no second window and no splash. It fills the window, with the Workbench mounted beneath it and
out of reach; Workbench shortcuts and menu commands do nothing while it shows. Finishing fades setup
away to reveal the Workbench already prepared behind it, so there is no second loading state.

Each page has one title, one sentence, one card and one primary action, centered. `Skip` stays
quietly at the top right, `Back` at the top left on the second page, and two dots at the top center
show the position. Enter presses the primary action as soon as a page appears, unless that action
only leads past what the page is asking for. Reduced motion removes the page and fade transitions.

## Connect an agent

The first page lists the Agents Nodex can run, with what it already knows about each. Agents that are
ready come first; once the first answer has arrived the order holds still, so a row never moves under
the pointer.

| Agent         | Ready when                           | Otherwise offers                                                       |
| ------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| Codex         | Its account is signed in             | `Sign in` with ChatGPT in the browser, or `Use API key`                |
| Claude Code   | A profile is installed and signed in | `Sign in` in a Terminal under the row, or `Install` with a preview     |
| Nodex credits | Signed in with a credit to spend     | `Get started`, then top-up tiers. Absent from a build without accounts |
| OpenCode      | A model is on                        | `Install`, then `Use free models`. Absent where it can't run           |

Nodex never copies credentials: each Agent keeps its own sign-in, and the page says so. Installing
Claude Code shows the vendor's own command first, and only `Run` starts it. OpenCode uses its existing
[install dialog](agent-backend-behavior.md). Its row says plainly that the free models' providers may
keep what is sent, and those models stay off until the person chooses them. Coming back to the window
checks again, so a sign-in finished in a browser or a Terminal shows up by itself.

Nodex credits are one way to start, and never a condition of starting. `Get started` opens the hosted
page, which covers a new account and an existing one alike. Once signed in with no credits, the
server's tiers sit under the row and one click pays in the browser; the row turns ready by itself when
the balance arrives. Credits are never chosen automatically, even for someone who just bought them, so
that person lands on a Composer asking them to choose a model rather than to connect an Agent.

Nothing on this page blocks the way forward. With no ready Agent the action reads
`Continue without an agent`, quietly and without taking the Enter key; `Skip` leaves the whole flow.
Either way a person with nothing to run lands on a Composer that asks them to connect an Agent.

## Where should agents work?

The second page offers the folders an Agent has already worked in, read from Codex and Claude Code
history, newest first with Git repositories ahead of other folders. Folders in one repository and
its linked worktrees count as one, named `owner/name` when its remote is recognizable. Scratch space,
downloads, Agents' own homes and folders that no longer exist aren't offered, and neither are folders
that are already Projects. The scan reads at most 500 conversations from each history, and a history
it can't read simply contributes nothing.

Repositories active in the last 30 days with at least three chats are selected to begin with. The
person can change that, add any folder with `Choose`, or `Start an empty project`, which makes a new
folder under the default projects directory and initializes Git. `Add project` creates an ordinary
Project for each selected row, and the page does not create anything before that. `Just chat for now`
continues with no Project.

`Also bring recent chats` is off to begin with and appears only when there are chats to bring. It
copies the selected folders' chats from the last 30 days, at most 20 from each, through the ordinary
[native conversation import](native-conversation-connection-behavior.md). Copies are made in the
background: progress replaces the dots while setup shows, each chat appears in the sidebar as it
finishes, and a toast reports the total. A chat that fails can be retried in Settings → Conversations.

## Landing

Finishing opens New Chat in the first Project added, with a first task in the Composer, not sent, and
the cursor ready. It doesn't add a suggestion card or a second way to enter a prompt.

| Chosen             | First task                                                                             |
| ------------------ | -------------------------------------------------------------------------------------- |
| An existing folder | Learn the project, write a short brief as a Page beside the chat, and change no code   |
| An empty project   | Ask what to make, build a small first version, and say how to run it                   |
| No Project         | Ask what the person is working on, and write a one-page plan as a Page beside the chat |

`Skip` lands on New Chat too, with an empty Composer. Setup creates no Page of its own: the first Page
an Agent writes shows what a Page is better than a description could.

## Afterward

The [analytics notice](product-analytics-behavior.md) waits until setup has finished, so its grace
period only runs once a person can see it.

A new chat with no usable Agent shows `Connect an agent to start`, whose action reopens just the first
page. Outside a Project, New Chat asks `What should we build?`, and the Composer's `Choose project`
offers the Projects. Sending before a model is chosen opens the model menu and keeps the message. The
first time an Agent finishes, if macOS hasn't been asked yet, the Composer offers
`Get a notification when an agent finishes?` once. Nothing is asked of macOS until the person says yes.

## Verification boundaries

Pure tests cover the open decision, step order, Agent rows, candidate grouping and setup commands.
Renderer tests cover the page workflows. `tests/e2e/first-run.spec.ts` covers a fresh Profile end to
end, resuming after a restart, and a Profile with existing work. Visual review uses a new home with
`vp run dev --home <dir>`.
