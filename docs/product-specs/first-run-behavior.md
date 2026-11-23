# First-Run Behavior

## Promise

Opening Nodex on a new Profile takes a person from nothing to an Agent working on their real code,
in about a minute, without creating anything they didn't choose. The first thing they see tells
them what Nodex already found on their computer, and the last thing they see is the real Workbench
with useful work ready to send.

Setup asks only what Nodex can't work out. It never stands between a person and the Workbench:
every page can be skipped, and everything it offers stays available afterward.

Nothing is explained before it is seen. Setup and the first task use only words a new person already
has; Pages, the Inbox and Agents working together each introduce themselves with one line, at the
moment they first appear (see [Tips](#tips)). A person with two Agents sees them work together in
the first chat, by sending a message they can read.

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

## Connect your agents

The first page lists the Agents Nodex can run, with what it already knows about each. Its sentence
says what they are for: `Use the coding agents you already have. Nodex lets them work together.`
Agents that are ready come first. Next come the ones already on this computer or in the Profile that
need one more step: a sign-in, a `Connect`, an update or another look. The ones that start from
nothing come last. Rows take their places once every Agent has answered, or after three seconds when
one is slow to answer, and from then on a row never moves under the pointer. An Agent that turns up
later joins the end of its group. A new API key appears above the way to add one without moving the
existing rows.

| Agent                      | Ready when                                          | Otherwise offers                                                       |
| -------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| Codex                      | Its account is signed in                            | `Sign in` with ChatGPT in the browser, or `Use API key`                |
| Claude Code                | A profile is installed and signed in                | `Sign in` in a Terminal under the row when found, or `Install`         |
| Antigravity                | A profile is installed, signed in and offers models | `Set up` or `Sign in` opens Settings → Agents → Antigravity            |
| An Agent added in Settings | Connected, with its models known                    | `Connect`, or its own `Sign in` under the row                          |
| API key                    | One row per connected key                           | `Add key`, with the form under the row                                 |
| OpenCode                   | A model is on                                       | `Install`, then `Use free models`. Absent where it can't run           |
| Nodex credits              | Signed in with a credit to spend                    | `Get started`, then top-up tiers. Absent from a build without accounts |

On Apple silicon, choosing the Codex sign-in or API key action installs the
[Codex Component](components-behavior.md) on first use. The row shows progress while the chosen
sign-in waits. If Codex is turned off, the row links to **Settings → General → Components**.

Antigravity's built-in row recognizes a downloaded runtime or an `agy` on this computer,
including installations on the login-shell PATH. An older command stays visible with the version
needed to connect. Its default profile uses agy's sign-in on this computer, so an `agy` already
signed in is ready without a step, and a sign-in finished in a Terminal shows up by itself. Set up
and Sign in open Settings → Agents → Antigravity, where other profiles connect their own accounts.

First-run uses the [same readiness facts](agent-runtime-behavior.md#agent-readiness-and-failures-around-the-composer)
as the composer and picker. An installed Agent can name an unreachable account, a check that
timed out, a needed version, or a failed start. `Check again` rechecks transient Agent failures.
Settings takes the person to the profile or section that owns configuration.

Codex's sign-in is read from this computer before anything is asked of the network, so being offline
never hides an account that is signed in, and never offers `Sign in` to someone who already has.
An Agent that is checked again in the background turns ready by itself once it can answer.

`Add key` opens the [API key form](agent-backend-behavior.md#api-keys): choose DeepSeek, Kimi, GLM,
MiniMax or another Anthropic-compatible endpoint, paste the key, and `Connect`. Nodex checks the key
with the provider before saving it and lists the provider's models; a refused key or an unreachable
endpoint is said under the form, with focus on the field to fix. Nothing needs installing.

Nodex never copies credentials: each Agent keeps its own sign-in, and the page says so. Keys given to Nodex are stored encrypted with the system keychain. Installing
Claude Code shows the vendor's own command first, and only `Run` starts it. OpenCode uses its existing
[install dialog](agent-backend-behavior.md). Its row says plainly that the free models' providers may
keep what is sent, and those models stay off until the person chooses them. Coming back to the window
checks again, both who is signed in and what is installed, so a sign-in, an install or an update
finished in a browser or a Terminal shows up by itself.

Nodex credits are one way to start, and never a condition of starting. Their row closes the list,
after everything a person may already have, and like any row it joins the ready ones once it is
ready. `Get started` opens the hosted page, which covers a new account and an existing one alike.
Once signed in with no credits, the server's tiers sit under the row and one click pays in the
browser; the row turns ready by itself when the balance arrives. Credits are never chosen automatically, even for someone who just bought them, so
that person lands on a Composer asking them to choose a model rather than to connect an Agent.

One quiet line under the list says where the person stands. With no Agent ready it reads
`You can add more in Settings → Agents.`; with one, `Connect one more and they can check each other’s
work.`; and once two that differ are ready it names them: `Codex and Claude Code can work together in
one chat.` Two Agents differ when they are different software, or the same software behind another
model provider's API key; two sign-ins to one Agent do not. The first named is the Agent a new chat
starts on, the second the first other Agent in the list that is ready with a model on. Credits are
never the second: a chat never spends them unasked. No team is named while a new chat would start on
a model that is off.

Nothing on this page blocks the way forward. With no ready Agent the action reads
`Continue without an agent`, quietly and without taking the Enter key; `Skip` leaves the whole flow.
Either way a person with nothing to run lands on a Composer that asks them to connect an Agent.

## Where should agents work?

The second page offers the folders an Agent has already worked in, read from Codex and Claude Code
history. Folders in one repository and its linked worktrees count as one, named `owner/name` when its
remote is recognizable, with the owner quieter than the name. Scratch space, downloads, Agents' own
homes and folders that no longer exist aren't offered, and neither are folders that are already
Projects. The scan reads at most 500 conversations from each history, and a history it can't read
simply contributes nothing. It offers at most 50 folders, keeping Git repositories ahead of other
folders when it has to leave some out.

The list starts with the most recently used folder. Above two or more rows, a checkbox selects or
clears every row at once, and `Most recent` and `Most chats` reorder the found folders strictly by
that measure, ties going to the other. Folders the person adds themselves stay on top in either
order. `Choose a folder` and `Start an empty project` stay below the list however far it scrolls, and
a folder chosen there scrolls into view, already selected.

Repositories active in the last 30 days with at least three chats are selected to begin with. The
person can change that, add any folder with `Choose a folder`, or `Start an empty project`, which
makes a new folder under the default projects directory and initializes Git. `Add project` creates
an ordinary Project for each selected row, and the page does not create anything before that.
`Just chat for now` continues with no Project.

`Also bring recent chats` is off to begin with and appears only when there are chats to bring. It
copies the selected folders' chats from the last 30 days, at most 20 from each, through the ordinary
[native conversation import](native-conversation-connection-behavior.md). Copies are made in the
background: progress replaces the dots while setup shows, each chat appears in the sidebar as it
finishes, and a toast reports the total. A chat that fails can be retried in Settings → Conversations.

## Landing

Finishing opens New Chat in the first Project added, with a first task in the Composer, not sent, and
the cursor ready. It doesn't add a suggestion card or a second way to enter a prompt.

The first task is the person's own message, so it is written for them to read: in the display
language, in plain words, naming nothing they haven't met. It asks for `a page in Nodex` rather than
a product term, and the Page the Agent then opens introduces itself.

| Chosen             | First task                                                                             |
| ------------------ | -------------------------------------------------------------------------------------- |
| An existing folder | Learn the project, write a short brief as a page beside the chat, and change no code   |
| An empty project   | Ask what to make, build a small first version, and say how to run it                   |
| No Project         | Ask what the person is working on, and write a one-page plan as a page beside the chat |

When two Agents that differ are ready, the first task puts both to work, and asks for the second by
its name: that is all it takes anywhere in Nodex, and the first task is where a person learns it.

| Chosen             | First task with a teammate                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------- |
| An existing folder | Learn the project while the teammate does the same on its own, compare notes, then the brief |
| An empty project   | Build the small first version, then ask the teammate to review it                            |
| No Project         | Draft the plan, ask the teammate to challenge it, then write the result as a page            |

The teammate is the one the first page named. Sending the task shows the second Agent at work in the
chat, with its own mark, and its conversation a click away. The person can still edit the task or
choose another model first; the wording stays theirs.

`Skip` lands on New Chat too, with an empty Composer. Setup creates no Page of its own: the first Page
an Agent writes shows what a Page is better than a description could.

## Tips

A tip introduces one thing at the moment a person first meets it: what the thing is, and one way to
try it now. Tips are the only teaching Nodex does after setup; there is no tour, checklist or
what's-new surface.

A tip must never read as something to fix, so it shares no look with a notice. A notice is a tinted
tab on the Composer, because it holds the Composer. A tip is one centered sentence above the
Composer in the quiet text color, with no surface, border or icon of its own. Its only color is a
small `Tip` badge. The thing to try is a word in the sentence with a dotted underline, not a button,
and the `×` that puts it away shows on hover or keyboard focus. It fades in over a third of a second,
and it touches nothing: the Composer and its tabs look exactly as they do without it.

| Tip            | When                                                                 | Says                                                                                  | Offers        |
| -------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------- |
| Page           | The Agent wrote or opened a Page in the Run that just finished       | `That’s a Page: you and your agents can both edit it. Mention it with @ in any chat.` |               |
| Second opinion | A Run finished, and another Agent that differs is ready              | `Want a second opinion? <Agent> can review this.`                                     | `Ask <Agent>` |
| Second Agent   | A Run finished, and no other Agent is ready                          | `With a second agent connected, they can check each other’s work.`                    | `Connect`     |
| Notifications  | A Run finished, and the system hasn't been asked about notifications | `Get a notification when an agent finishes?`                                          | `Turn on`     |
| Inbox          | New Chat, while another chat is working                              | `More on your mind? Drop it in the Inbox and Nodex suggests where it should go.`      | `Open Inbox`  |

- **One at a time, one per rest.** A chat speaks only when its Agent is at rest, and each rest
  between Runs has room for one tip, the first in the table's order that still applies. Settling a
  tip leaves that rest quiet instead of bringing up the next.
- **Once.** A tip is settled for good when the person acts on it, dismisses it with its `×`,
  or carries on past it by sending their next message. It never returns, in any window.
- **Never in the way.** A tip gives way to every condition that holds the Composer (an Agent to sign
  in, a model that is off, paused work) and to a suggestion answering what is being typed, and never
  holds sending itself. Only a person's own chats speak; an Agent's helpers, side chats and a
  floating Composer stay quiet.
- **Hands-on.** `Ask <Agent>` adds `Ask <Agent> to review your work above, then tell me what you’d
  change.` to the Composer, after anything already drafted there, unsent and in the display
  language, so the person sends the request themselves and sees that asking by name is all it takes. `Connect` opens the first setup page.
  `Open Inbox` opens the Inbox of where the person is. `Turn on` is the only thing that asks the
  system for notification permission.
- **Outgrown.** Once another Agent has worked in a chat the person has open, the two teamwork tips
  are settled unseen: Agents that have worked together need no introduction.
- **Off.** Settings → General → `Show tips` turns all of them off, and is on to begin with.

## Afterward

The [analytics notice](product-analytics-behavior.md) waits until setup has finished, so its grace
period only runs once a person can see it.

A new chat with no usable Agent shows `Connect an agent to start`, whose action reopens just the first
page. Outside a Project, New Chat asks `What should we build?`, and the Composer's `Choose project`
offers the Projects. Sending before a model is chosen opens the model menu and keeps the message.
What comes next is introduced by [Tips](#tips).

## Verification boundaries

Pure tests cover the open decision, step order, Agent rows, their problems and their settled places,
the API key form, found Agents, candidate grouping, setup commands, which Agents make a team, the
first tasks, and which tip a moment calls for. Renderer tests cover the page workflows and a tip's
turn. `tests/e2e/first-run.spec.ts` covers a fresh Profile end to
end, resuming after a restart, and a Profile with existing work. Visual review uses a new home with
`vp run dev --home <dir>`.
