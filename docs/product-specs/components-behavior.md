# Components Behavior

Plugins and the Voice and Chats settings show the Codex requirement when the
managed Component is unavailable. Start the install from those settings or the
Plugins directory and keep using the same window while Codex becomes available.

## Promise

Nodex installs small and stays small where a person wants it to. Large parts that only some work
needs are Components: Nodex downloads them after the app is installed, in the background or the
first time something needs them, and a person can remove any of them to free its space. No
Component is needed to open a Space, read or edit Pages, search, or use Git. An Agent that runs on
a Component is unavailable, never broken, until that Component arrives; other Agents are unaffected.

A person never has to act for a Component to arrive, and never downloads one they do not use. They
never wait on one to use the rest of Nodex, and an app update does not download a Component again
unless that Component itself changed.

## What is a Component

A Component is a sealed archive that one exact build of Nodex names by address, byte size and
SHA-256. The build decides which version it uses; there is no separate version to choose and no
update channel of its own. A Component is the same on every computer that runs that build.

| Component      | Provides                                                                         | Installs          |
| -------------- | -------------------------------------------------------------------------------- | ----------------- |
| Desktop Tools  | Browser Use, control of existing browser profiles, Computer Use                  | When Nodex starts |
| Codex          | Codex accessed with a ChatGPT account, an API key or Nodex credits               | On first use      |
| Claude Code    | Claude models accessed with an API key or Nodex credits                          | On first use      |
| Document Tools | Managed Python and libraries for Word, PowerPoint, spreadsheets, PDFs and images | On first use      |

Components install after the app on macOS with Apple silicon.

On Windows, supported runtimes ship with the app. Development builds ordinarily use staged
runtimes. Settings lists only the Components available as downloads on this build.

## Installing

Nodex installs one Component at a time. A Component that installs at startup
queues whenever it is on and its current version is missing. A first-use
Component stays on and waiting until a feature needs it. Once requested, Nodex
remembers that use and installs the current version in the background after a
restart or app update. Turning it off clears that history, so if its files are
removed it waits for a feature to need it again.

When matching Codex package files are already on the Mac, Nodex copies them into the
Component store and verifies the copy before use. A complete match avoids the download.
The installed Component stays independent of the original installation.

- A download continues where it stopped after a lost connection or a restart.
- When a download cannot start or finish, Nodex tries again by itself, waiting longer between
  attempts, for as long as the Component stays on.
- Downloaded bytes that differ from what the build names are discarded and fetched once more from
  the start. A second mismatch stops the install until a person retries.
- Nodex checks for free space before it downloads, and reports when there is too little.
- Every file is checked against the build before the Component is used. Files this build cannot use
  are deleted, and the install stops until a person retries.

A Component becomes usable as soon as it is installed. The app does not restart, and Agent work
that starts afterwards can use it.

While a Component installs, the rest of Nodex stays usable. Features show the
Component's installation state when they need it to run.

- **Codex.** An existing sign-in or Codex Session, access to Codex models with Nodex credits,
  choosing a Codex model, or starting sign-in requests Codex. Sign-in waits for installation
  before it opens the browser or uses the API key. The composer keeps Codex selected while its
  installation is in progress and holds sending until it is ready. Without a reason to install
  Codex, a new chat starts with another available Agent or asks the person to connect one.
  An executable chosen in **Settings → Agents → Codex** supplies ordinary Codex chats.
  Nodex credits still use the Component.
- **Claude Code.** Connecting an API key or gaining access to Claude models through Nodex credits
  is its first use. These models stay visible in the composer while Claude Code installs, cannot be
  sent to until it is ready, and become selectable by themselves. The picker offers a retry after
  a failure that will not retry by itself, and a link to Components when Claude Code is turned
  off. A person's own Claude Code installation never uses or requests this Component.
- **Document Tools.** An Agent's first request for the document tools is its first use. The request
  waits for the install, up to three minutes; after that the Agent is told they are still
  downloading and to try again shortly, and the install continues.
- **Desktop Tools.** Browser and Computer Use settings show the install's progress in place of
  their own readiness until it finishes.

## Removing

Turning a Component off removes it and stops Nodex from downloading it again, including after
updates. A download in progress is canceled and its partial file deleted.

Files that the running app is using stay in place until Nodex next starts, and the row says so.
Turning the Component back on before then keeps them, with nothing downloaded.

## After an update

When an app update is ready to install, Nodex can download new versions of Components you
already have while you keep working. You can restart as soon as the app update is ready.
After restarting, Nodex checks the prepared Components and uses them. It finishes any
remaining downloads in the background. Each affected Component is available once its new
version is ready.

## Settings

**Settings → General → Components** lists the Components this build installs after the app. The
section is absent when there are none.

Each row names the Component and what it provides, and carries one switch. On keeps it installed;
off removes it. Beside the switch the row states what is true now:

| State                             | Row shows                                            |
| --------------------------------- | ---------------------------------------------------- |
| Installed                         | Its size on disk                                     |
| Off                               | The size of the download                             |
| On, nothing has needed it yet     | That it installs on first use, and the download size |
| On, waiting for its turn          | Waiting to download                                  |
| Downloading                       | Percent of the download size, and a progress bar     |
| Unpacking and checking            | Installing, with the bar full                        |
| Download failed, Nodex will retry | That it will try again, and **Try now**              |
| Stopped until a person acts       | Why, and **Try again**                               |
| Off while the running app uses it | That it is removed when Nodex restarts               |

One line under the list says what the switches do, since no other switch in Settings removes
files.

The choice belongs to the Profile and is stored in its configuration; see
[Configuration](../CONFIGURATION.md).

## Where files live

Installed Components live in the Profile, under `components/`, one directory per Component and
version. A directory there is always complete: an install unpacks beside it and appears in one
step. Backups and Space data do not include them.

On Apple silicon, a Space host started with `nodex serve` also installs Claude Code and Document
Tools on first use. It keeps its own component store under `runtime/host/components/` in the
execution home. Desktop Tools are available in the desktop app.

## Privacy

Installing a Component is a plain download of a public file. Nodex sends no account, Profile or
usage information with it. The desktop app uses the system's proxy settings. A Space host uses
Node's `HTTPS_PROXY` and `NO_PROXY` environment settings.
