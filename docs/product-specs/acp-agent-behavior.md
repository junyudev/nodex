# ACP Agent behavior

ACP instances connect user-selected Agents to Nodex conversations. Each named instance owns a
stable configuration identity and a particular native environment. The same Agent can have several
instances. Registry, login and installation state do not replace that identity or the product Session.

## Configuration and installation

An instance selects either a Registry Agent or a local executable with individual arguments.
The logical Agent and known native storage/authentication roots are fixed once saved; use a new
instance for another native profile. Names, installation versions, executable location, models and
authentication tokens remain editable without changing identity.
Arguments are passed as values without shell interpolation. Registry selection supports the
available binary, npm and uv distributions; a concrete receipt pins an installed version and target.
An executable override does not implicitly add startup arguments. Local sources support Agent-specific
startup options such as an externally selected model.

The Profile stores configuration and encrypted environment references in Main. Secret reads are
masked, edits preserve unchanged secrets, and removal releases owned secret references. Runtime
holds launch configuration in memory. Explicit environment, credential-home and proxy choices
determine inheritance; native software may additionally choose its own configuration roots.

Searching and reading installation state are passive. Installing, updating, connecting, logging in
and uninstalling require their corresponding explicit actions. Installation has bounded diagnostics,
progress, cancellation and retry; duplicate operation IDs do not repeat the work. Private staging is
published atomically only when ready. Failed or interrupted staging cannot become an installed receipt.
Available installations continue working when the catalog is offline. Uninstall never removes local
executables or an installation used by admitted work.
An active installation, a saved configuration reference or a preparation reservation blocks uninstall
with a busy result. Preparation reserves the completed installation briefly until configuration takes
ownership; an unclaimed reservation expires so it does not prevent later cleanup.

Updates select a new installation without changing an instance's identity. Active and queued work
retain captured launch configuration. Disabling or removing an instance immediately blocks new
work across direct submission, queue append, delegation and Automation. Existing admitted work
continues with its captured configuration unless cancelled. Pending ordinary edits apply after the
instance is idle; an unavailable instance never silently falls back to another Agent.
Current configuration status can be queried without starting an idle Runtime or probing an Agent.
Pending state ends when the saved configuration is applied; a failed refresh is not reported as applied.

## Authentication and connection

Supported flows include Agent-managed login, interactive terminal login, URL information requests,
explicit environment credentials and rechecking after login with an external CLI. A successful
terminal exit triggers a new authentication check; it does not itself establish authentication.
The Agent owns its native credential files. Environment secrets submitted to Nodex use the Profile's
encrypted secret store and are never copied into Runtime settings or installation receipts.

Operations bind their instance, owner, configuration and Runtime lifetime. Closing an authentication
flow cancels its interaction and owned terminal. Closing an installation observer allows installation
to continue. Main observes completion independently of the originating window and refreshes connected
catalog consumers after successful installation, connection or authentication. Expired, cancelled and
superseded answers cannot complete another flow. Credential coordination is separate from native
history identity. Each instance claims its canonical home and supported potential credential roots;
intersecting claims within the same source coordinate login, logout and model-service writes with
active work. Logical labels and unrelated toolchain or cache directories cannot remove those claims.
Independent isolated homes with no shared credential roots can authenticate concurrently.

Explicit connection can create a temporary native session to discover the Agent's capabilities,
commands, models and configuration. It creates no Nodex Session or Run and sends no prompt. Search,
passive inspection, cached catalog reads and stored-history browsing do not perform this probe.
Installation readiness and sign-in are separate from discovery. The instance reports discovery as
unknown, ready or failed; unknown discovery offers no inferred models. Verified models, commands,
native capabilities and failed authentication survive an idle Runtime restart. Effective executable,
launch arguments, native profile or environment changes invalidate that state without starting an
Agent. An Agent without a model API offers its startup Default only after a real session confirms
that capability. Saved metadata excludes login URLs and masks echoed environment secrets.

## Models and execution

The client negotiates stable ACP v1 and the pinned v2 schema. Wire shape participates in generation
selection because numeric version alone can be misleading. Methods are gated by actual capabilities.
Files and terminal callbacks use the applicable generation's transport; v2 MCP uses its negotiated
tunnel rather than advertising removed v1 callbacks.

The model menu preserves exact native IDs. Model config options take priority; legacy session models
use the native model method when config options are absent. Literal auto/default IDs are ordinary
advertised models. Explicit custom IDs are submitted for Agent validation. A rejected or unavailable
selection cannot become an apparently successful switch or send the task with a different model.
Agents without a model API use their configured startup model and cannot promise a live switch.
Their catalog exposes only the startup selection; an explicit unsupported model fails before a prompt.

Boolean, select and grouped configuration choices, modes and live command updates use the existing
Composer. Empty protocol values remain selectable through reversible presentation keys. Model
changes and partial configuration failures preserve the actual applied state. Run admission captures
its own model selection, so editing the current Composer cannot rewrite queued work.

Conversation events retain text, thought, tools, plans, files, usage, supported images and native
extensions through the existing normalized Runtime history. Native permissions use full access;
questions that need user information remain interactive. Dedicated compatibility adapters require
evidence of their native capability and never infer it solely from an executable basename.

Claude ACP follows native working and idle state only after actual v2 wire negotiation. A finished
foreground Run can retain live native child work, including nested children, and later status or
output keeps its original lineage. Reusing a native child session keeps that child Thread and
creates the appropriate subsequent Run. Pending information questions block false idle completion.
Ordinary ACP Agents without those native events do not acquire invented child relationships.

Cancellation retires the affected native source and its interactions, including owned background
work. Late output cannot revive a cancelled source. Protocol corruption, process loss and bounded
intake failures have explicit failure and cleanup behavior. Reconnection never resubmits an old
prompt to manufacture successful recovery. Unsupported utility generation does not create hidden
Agent prompts; automatic titles retain the deterministic temporary title.

## Native history and model services

Native history lists use the Agent's pagination and workspace context. Import first admits and binds
a Core product Session, then materializes a Runtime Thread with an idempotent native mapping and
without a prompt. The mapping includes a non-secret source fingerprint, so the same native ID in
another storage or account scope cannot reconnect to the old chat. Renaming or upgrading an instance
does not invalidate an unchanged native source.

Restoration uses advertised v1 load, v1 resume or v2 resume/replay. A resume-only Agent can continue
its context without supplying earlier transcript replay; Nodex saves its subsequent history from
that point. Stored Nodex history remains passive and paged. Missing native sessions fail restoration
and retain the captured native identity and saved Nodex history. The current Run fails without a
replacement native session or portable prompt replay; starting a separate conversation is an explicit
user action. This applies both when opening a saved session and when continuing after cancellation.
Recognized missing-history errors stop after one restoration attempt; unknown startup failures retain
bounded retries.
Fork, close and delete are offered
only when supported. Product chat deletion does not implicitly delete native history, and mapped
native history is protected from direct deletion.

Agents advertising model-service management expose supported API types, required providers and
current endpoint configuration. Credentials are accepted as secret input and never returned. Required
providers cannot be disabled, including by direct management calls. Endpoint writes, disable and logout
refuse busy credential scopes before issuing a native write. Successful changes refresh provider and
model state.

## Verification

Scripted peers prove both protocol generations, minimal capabilities, installation and auth lifetimes,
model methods, import identity, cancellation and failures without paid services. Real Agent evidence
records the exact executable and schema versions and actual model IDs. macOS arm64 requires real
packaged Node PTY and installation execution. Other host/architecture combinations require equivalent
execution evidence before being declared verified. Account promotions and model prices are not protocol
capabilities or permanent product promises.
