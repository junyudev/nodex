# Antigravity Agent behavior

Antigravity is Google's coding Agent. Nodex runs it as a built-in Agent beside Codex, Claude
Code and OpenCode: it has its own section in Settings > Agents, its own mark in chats, and its
limits among the usage meters. Configuration and storage are in
[Configuration](../CONFIGURATION.md).

## Profiles

A profile is one account. The section starts empty; **Add profile** creates one, and each saved
profile is a row with its own switch. Opening a profile shows, in order, its name, account,
sign-in method, the credentials that method reads, and its executable. A link to a profile from a
chat opens that profile.

| Sign-in method             | The profile needs                                  |
| -------------------------- | -------------------------------------------------- |
| Google account             | A Google sign-in in the browser                    |
| Gemini Enterprise          | A Google sign-in, a Google Cloud project, location |
| Gemini API key             | An API key                                         |
| Agent Platform (Vertex AI) | An API key; project and location are optional      |

A Google account uses the plan it belongs to; API keys and Agent Platform bill for use. An API
key is stored encrypted on the computer and never shown again. A profile whose method reads no
key keeps none. Nodex keeps each profile's sign-in apart from Antigravity in a terminal or IDE
and from other profiles, and credentials in the environment do not reach it, so a profile only
ever runs as the account it was given.

Turning a profile off stops its chats and keeps its sign-in. Removing a profile keeps its chats'
history.

## Account

An enabled, saved Antigravity profile has an Account row in Settings. Google account and Gemini
Enterprise profiles use **Sign in**. Open the sign-in page in a browser or copy its link, then paste
the code from the final Antigravity page or that page's full URL. Gemini API key and Agent Platform
profiles use **Connect** to verify their saved configuration directly.

Nodex shows the active sign-in or verification step and puts any failure in the Account row.
The window that starts sign-in owns the response and can cancel it. Closing the last surface
showing that flow also cancels it. Opening Account can show the last known state while execution is
idle. Completing sign-in refreshes the account and its models. When the Agent supplies an account
email, the row shows **Signed in as** with that email.

**Sign out** asks for confirmation. Confirming stops running chats on the profile and clears its
account and model availability. Chat history and workspace files stay available.

## Runtime

Antigravity profiles share one downloaded runtime in the current Nodex Profile.
With an empty executable path, a profile uses the downloaded runtime when present,
then looks for a compatible `agy` on the desktop PATH, the login-shell PATH and in
common install directories. Nodex skips executables that identify themselves as
the Antigravity IDE and prefers the first compatible CLI in search order. When all
recognized versions are too old, it shows the newest one and the minimum required
version in Settings and setup. An explicit path selects that executable. Settings
shows which executable a profile will use and any issue that prevents it from
starting chats.

Opening the runtime row reads local files and the last observed versions when
Agent execution is running. When execution is stopped, Settings shows the last
inspection if available. Opening the Antigravity section with a profile, choosing
**Check runtime**, or opening or returning to Nodex setup can start execution and
read `agy --version`. These checks
leave downloads and sign-in alone.

**Install** downloads and verifies the runtime. **Check for updates** looks for
a release and installs a newer compatible version when available. When Nodex
knows an update is available, the action reads **Update**. Settings shows the
download and installation phase, with **Cancel** while cancellation is possible.
All personal windows show the same progress, and closing Settings or its window
leaves the operation running. A version below the minimum blocks new chats.
A version below the recommendation shows the recommendation.

**Remove** asks for confirmation and removes the downloaded executable.
Sign-ins and chats are kept. Antigravity must be out of use, any installation
must finish, and any explicit executable paths into the download must be cleared
before removal. On a computer without automatic installation support, set an
executable path.

The managed runtime publishes installation facts for [Agent readiness](agent-runtime-behavior.md#agent-readiness-and-failures-around-the-composer).
Setup and the composer combine those facts with the selected profile's account and model state.

## Chats

Antigravity chats use the models offered to their configured account, including Gemini
and any Claude or GPT models the account offers. The picker uses the Antigravity mark
and the model name. Antigravity has no custom models. A model's Thinking level appears
once Antigravity has reported the levels that model supports. The session default appears
as the actual available model or as **Choose model**. An existing chat keeps its exact
profile and model when either becomes unavailable. Scheduled chats can select a configured
Antigravity profile, model and thinking level.

Use Antigravity's native `/plan` command for planning. The Composer lists the slash commands
the Agent advertises. Permission choices follow the same catalog. Nodex applies its approval
policy while Antigravity stays in its native default mode, and offers native Auto only when
the Agent advertises it. **Edit from here** starts a fresh provider session and replays
the conversation up to the edited message.

Project skills resolve in this order when names overlap: `.gemini/skills`, `.agents/skills`,
then `.agent/skills`. Account-wide skills come from `~/.gemini/config/skills`. Available
skills appear in the Composer for the current workspace.

Images use the model's image input. Supported audio, PDFs and text documents are included
when the session accepts their content type. Other files, folders and line ranges are
referenced by path in local chats.

Conversations from the Antigravity app and its command line can be copied into Nodex chats from Settings >
Conversations; see [Antigravity history](native-conversation-connection-behavior.md#antigravity-history).

A native Antigravity subagent call appears in the transcript and the Subagents tab. Its
read-only detail opens beside the chat and shows the children Antigravity can identify,
with their roles, prompts and recent steps. Individual children have no composer or Stop
action. A batch going idle leaves each child's outcome to its own transcript.
