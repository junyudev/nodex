# Desktop control surfaces

Nodex presents Browser Use, control of supported browser profiles, and Computer Use through one native desktop-control system. The task transcript remains the durable record; live screenshots, remote layers, native placement, and cursor state are bounded ephemeral projections owned by the Main process.

On macOS, these Agent capabilities use the Desktop Tools Component installed in the
Profile. New Agent execution can use Desktop Tools as soon as Nodex finishes
verifying the installation. If the Component is removed while in use, Nodex
releases its files the next time it starts.

## Availability

The built-in Browser is available to local Agents on macOS and Windows when the verified runtime and its transport are ready. Control of an existing browser profile additionally requires a supported browser family, the installed native host, and a connected allowed extension instance. Browser Settings reports the live provider state as checking, unavailable, not registered, registered elsewhere, needs repair, waiting for extension, or ready. Agents can select the existing-browser backend only in the ready state.

On macOS, the installed app registers the host for the personal Profile and repairs registrations
whose host executable has disappeared. A registration pointing to another
existing host stays with that owner. Development instances leave the user's
registration alone by default. An explicitly opted-in development instance
registers for the duration of that launch and gives back its registration on
clean exit if it still owns it. On macOS, disposable Electron scenarios use a
registration home inside their own Profile. Windows scenarios leave HKCU untouched.

Computer Use is available only when its verified helper and operating-system requirements are ready. Its service uses the Desktop Tools runtime and the owning Profile without requiring a separately installed Codex app or sharing another Profile’s configuration. A failure in one control backend does not weaken or implicitly enable another. Desktop tools are available to local Agent execution. Remote and WSL execution do not receive local desktop tools. Native picture-in-picture is available on macOS.

On Windows, Computer Use uses the verified helper for the installed architecture. A local Agent
can request app access through the chat's normal approval flow. Windows Computer Use settings show
availability, the Computer Use switch, and any app approvals saved in the user's Codex configuration.
Removing an app from **Always-allowed apps** revokes its saved approval. Turning Computer Use off
closes its connection and stops its helper, including for chats that already opened it.
The helper owns Windows capture, input, privacy indicators, Escape handling, and restrictions
on controlling elevated windows. Locked Use, click sounds, and Messages
approvals are macOS features.

Local chats receive the desktop tools alongside the user's own MCP servers. Codex chats also receive Desktop features. When desktop tools cannot be prepared, the chat continues without them. The built-in Browser opens in the window that sent the message. A turn that no window sent, such as a queued, scheduled, or Agent-started turn, keeps the Browser window the chat already had. Archiving or deleting a chat releases its Browser pages and closes its Runtime-owned JavaScript session. A chat's JavaScript session keeps the bindings its Agent built while the chat is in use; after 30 minutes with no turn using it, the session and its processes close, and the chat's next JavaScript call starts a fresh session.

An Agent's JavaScript session keeps what the Agent has set up in it, such as its connection to the Browser, for as long as the chat's Runtime runs it. A message sent while the Agent is working redirects the Agent at once but does not discard that session: a script already running finishes, and the Agent's next script runs after it with everything still in place. Stopping the reply is what stops a running script, and it starts the session over.

### Choosing a browser

On macOS, Nodex connects to Chrome, Edge, Brave, Opera, Vivaldi, Dia and Arc through the
ChatGPT extension. A connection uses the existing browser profile and its sign-ins. The
in-app Browser keeps its own sign-ins. Browser Use can report the current HTTPS default
browser, whether Nodex supports it, and which extension profiles are connected. On macOS,
Browser Use checks whether a supported browser is running by its application identity. Nodex
identifies Dia and Arc from their signed running applications. If it cannot verify a
Chrome-compatible browser's app, it reports the app identity as unknown. Tab focus stays
bound to the exact connected extension and tab.

An explicitly selected browser or tab remains in force for the task. For account work
without a named browser, the Agent prefers a connected profile with the site open, then a
connected profile of the system default browser, then the in-app Browser. An open tab
helps the Agent choose where to start. The requested page determines whether sign-in is
required. If the expected browser is unavailable, the Agent explains which browser it
selected and what the user can do. If the user named the unavailable browser, the Agent
reports the reason and waits for it to connect or for the user to choose another browser.

### Existing browsers on Windows

Nodex connects to Chrome and Edge through the ChatGPT extension. Browser Settings shows **Waiting for extension** until an allowed extension instance connects. **Ready** means Nodex can address that instance and its tabs. Browser discovery uses the extension's exact ID and instance ID.

Windows registers the browser host for the current user. The Chrome and Edge native-messaging keys under \`HKCU\Software\Google\Chrome\NativeMessagingHosts\` and \`HKCU\Software\Microsoft\Edge\NativeMessagingHosts\` are shared by the 32-bit and 64-bit registry views. Nodex writes each key once and leaves machine-wide entries alone. The browser opens the manifest in the owning Nodex Profile, which points to the verified host executable for the installed Windows architecture.

The installed app registers for the personal Profile. Development instances can use `vp run dev --register-browser-host` to register for one launch and give back any registration they still own on clean exit. A durable Nodex registration remains owned by its Profile until released. Another Profile shows **In use by another Nodex Profile**. When another app has registered the host, Browser Settings shows **In use by another app** and the app's manifest path. **Use with Nodex** replaces the displayed registration. **Give back** restores the previous registration and turns browser control off. **Turn off** also releases registrations created by Nodex. A registration changed elsewhere after Nodex took ownership stays in place.

The Profile keeps its recovery receipts at `runtime/agent/chrome-control/windows/registration-v1.json`. The Windows installer uses the current Chrome and Edge defaults to find the owning Profile, including custom Profile homes. During uninstall or install-over, it restores each default only if the receipt belongs to the affected installation and still matches the current registry value. A receipt with no prior default removes Nodex's default and removes a Nodex-created key only if it is empty. Installer maintenance stops the installed REPL and helpers before removing payload files. Profile files and copied hosts are retained. After upgrade, Nodex can register the new verified host under the usual ownership and takeover rules. Giving back control from Settings also removes the Profile's entries from the shared host resource lists.

## JavaScript sessions

Outside Codex, each chat has its own JavaScript session. While its kernel is live, bindings survive
chat turns and provider restarts. A change to the effective execution policy or working directory starts
a fresh kernel. Stopping a running JavaScript call resets its bindings. A fork has its own session.

On macOS, the effective chat permission mode applies to JavaScript and its child commands:

| Mode                               | Reads                                    | Writes                                                                                                                   | Direct network             |
| ---------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| Ask for approval or Approve for me | OS-readable paths allowed by the sandbox | The execution workspace, Project Sources, attachments, and the session scratch directory, subject to sandbox protections | Blocked                    |
| Full access                        | Paths the OS account can read            | Paths the OS account can write                                                                                           | Allowed within host policy |

Codex also honors writable roots in its native workspace policy, which can include the system
temporary directory. A native Codex read-only context follows its read policy and blocks
filesystem writes and direct network by default. Windows retains its existing desktop tool
execution behavior.

`nodeRepl.cwd` reports the working directory. `nodeRepl.tmpDir` reports the temporary directory.
On macOS, each live REPL has a private scratch directory for temporary files. It is removed when
the process exits, with abandoned directories cleaned up on startup. Host-managed REPLs are
released after 30 minutes without activity. A kernel reset clears bindings. Other processes under the same OS account can read scratch files if their read policy
permits it. An Agent keeps secrets in memory and sends them directly to the intended command.

The JavaScript approval card shows the code and can allow JavaScript for the chat. The allowance
survives Stop and app restarts and ends when the chat’s permission mode changes. Site and app
consent is separate and can offer approval once or for the chat. Full access accepts these
consent requests without asking and declines a request that needs a typed answer. A request that
requires automatic review is declined in every mode.

## Built-in Browser screenshots

Agents can capture a tab while the built-in Browser is opening, hidden, or in the background. Nodex makes a temporary paint surface available when the tab needs one. If the tab still cannot produce a frame, the screenshot error describes what failed and tells the Agent it can retry.

## Website tools

The built-in Browser advertises website tool discovery and invocation through its WebMCP capability. The registry is installed on `document.modelContext` before page scripts run. Registration requires a secure context and origin-keyed agent clustering for network documents; local file documents use their secure-file boundary. Tool definitions and results must be JSON-serializable; registrations belong to the current document, support abort-based removal, and carry identities that reject stale discovery results after replacement or removal. Unsupported user-interaction requests fail explicitly.

The page bridge exposes only this document-owned registry and callbacks. It grants no host, filesystem, or general application IPC capability. Browser Use continues to apply its existing page admission and policy boundaries. Discovery and invocation metadata accompanies the tool result so the transcript can show each website action with its definition, input, output, and explicit truncation state; see [Thread Transcript Behavior](codex-thread-transcript-behavior.md).

## Native picture in picture

An admitted local task becomes active when Browser Use has an open session or Computer Use has an active item. Main admits desktop activity from the current local Codex connection or from a live Agent Runtime lease and its authorized Run attempt. Both producers address the same task, the chat’s execution root Thread. Browser Use and Computer Use can be active in the same task and retire independently. Browser presentations retain only the bounded latest accepted raster for each open presentation. Computer Use remains a native remote layer and is not copied into renderer history.

The native stack attaches to the focused eligible Nodex window, then the most recently eligible window, or the only eligible window. It follows native window movement without renderer animation frames and disables both stack-placement and companion-window motion when the system requests reduced motion. The stack may move to the restricted companion overlay; that overlay has no restorable Workbench Session and does not own task state. When the same Browser surface is already visible in the selected Nodex window, its duplicate native presentation is temporarily suppressed without changing the user's visibility choice.

Clicking a built-in Browser presentation focuses its exact task tab. Clicking an existing-browser presentation focuses the exact connected extension instance and tab. A stale, disconnected, or mismatched instance is ignored rather than falling back to another profile.
Presentations produced by the policy-gated CDP backend are display-only and do not borrow the built-in Browser focus route.

## Visibility and lifecycle

Users can show or hide one active task, hide all active tasks, or globally suppress native picture in picture. Main persists the global setting, maximum display size, and per-task visibility in the local Profile, keyed by the execution root Thread. Reloading, closing, or archiving a task preserves its choice; permanently deleting the task removes it.

Renderer windows read a bounded revisioned snapshot and submit intents. They do not own active-task truth, the complete visibility map, native callbacks, Browser images, or window attachment. Ending a Turn or Run attempt, archiving or deleting its Thread, losing or replacing its execution generation, and quitting Nodex release its presentations. A new connection or Runtime lease starts empty.

## Failure and privacy behavior

Malformed or oversized Browser images are rejected before native decoding. Main bounds presentation count and estimated decoded bytes per session, task, and process. Diagnostics contain only bounded operation/result fields, coarse timing, backend/family, revision, and a salted task hash; they never contain screenshots, URLs, page titles, prompts, or raw extension payloads.

If the native host, Computer Use service, or browser extension disconnects, Nodex keeps task and preference truth in Main, releases identities that can no longer be addressed, and reconciles only against a newly verified service or extension instance. Auxiliary UI failure cannot fail the Agent protocol generation.
