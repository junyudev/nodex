# ADR 0070: Configured ACP Agents and explicit management

- Status: Accepted
- Date: 2026-10-24
- Owners: Nodex maintainers
- Refines: [ADR 0068](0068-agent-runtime-execution-authority.md)
- Supersedes: the fixed ACP definition allowlist, stable-v1-only and scheduled-execution restrictions, and future third-party installation policy in [ADR 0056](0056-native-codex-and-capability-negotiated-agent-backends.md)

## Context

An ACP Agent is user-selected local software with its own account, model catalog and native history.
Restricting its configuration to one npm package prevents users from connecting other conforming
Agents and hides protocol capabilities that the execution runtime already negotiates. Installing,
authenticating and inspecting an Agent also have different effects from submitting a task.

The Desktop Host already owns Profile configuration and encrypted environment references. The
Agent Runtime already owns provider processes and execution history, while Core owns product
Sessions. ACP management must follow those owners without creating another configuration store
or content writer.

## Decision

Main owns named ACP instances, their immutable identity, source selection and credential environment.
Local sources specify an executable and individual arguments. Registry sources select an official
catalog entry and a concrete installation receipt. Definition identity describes the logical Agent;
it is not a launch allowlist or an inferred capability. A different logical Agent requires a new
instance. Existing instance and execution identities survive renaming, relocation and upgrades.

Runtime owns typed Registry, installation, authentication, connection, native-session and model-service
operations. Main supplies trusted Profile, window and execution context. Renderer callers cannot
choose arbitrary Runtime methods or manufacture operation ownership. Operation results are bounded,
redacted and fenced to their owner and configuration. Core owns Session admission and binding before
Runtime materializes an imported execution Thread.

Registry search, passive installation inspection and stored-history reads do not install software,
start authentication, create sessions or send prompts. Explicit installation and connection actions
own those effects. Connection may create a temporary native session to discover options; it never
creates a product Session or sends a user or utility prompt.

Registry installation is an explicit installation of third-party software selected by the user.
Nodex installs it into private owned directories with concrete versions, atomic publication and a
receipt recording source, target and verified bytes. A locally recorded digest is not proof of
publisher authenticity or an immutable transitive dependency closure. This differs from dependencies
distributed as part of Nodex itself: those retain the locked, verified build and release contract.
User-managed executable paths remain outside the installation owner's cleanup authority.

Main is the only writer of instance configuration and secrets. Runtime receives the current
configuration in memory and rejects attempts to persist another copy through its settings writer.
Desired admission policy applies immediately when an instance is disabled or removed. Captured
execution configuration remains available to work already admitted until it finishes or is cancelled;
it cannot authorize a new direct submission, delegation, queue append or utility request.

Scheduled work uses the same configured ACP binding and Session admission as interactive work.
Definitions retain the exact instance and logical Agent; a Heartbeat retains its target Session's
binding. The Host validates the current instance before execution, including when a cached catalog
still describes an instance that was disabled or removed. An unavailable instance fails admission
without selecting another Agent. The detailed contract remains in
[Scheduled route behavior](../product-specs/scheduled-route-behavior.md).

The client supports stable v1 and the repository's pinned v2 schema through generation-aware adapters.
This does not promise compatibility with future drafts. Advertised capabilities determine methods,
model selection, authentication and restoration. Config options take priority over legacy model and
mode APIs. Native IDs and option values retain their protocol meaning, including literal auto/default
model IDs and empty choice values.

Native history mapping binds the instance, native session and non-secret source identity. Changing
native storage or account roots cannot reconnect an old product Session to another source that reused
the same native ID. Saved instances therefore keep their logical Agent and known native storage scope
fixed; a different native profile uses a new instance. Runtime additionally protects existing native
mappings from direct configuration changes. Renaming, executable relocation, upgrades and token edits
do not change the native scope. Without replay, continuation does not imply that earlier native messages can be
displayed. Product history deletion and native history deletion remain distinct operations.

Terminal authentication runs in the standalone Runtime with a separately built Node-compatible PTY
dependency. Electron-native module artifacts are not reused by that process. Actual packaged Node
execution, cancellation and authentication recheck are required evidence; an exit code or successful
bundle alone does not prove authentication or native-module compatibility.

## Consequences

ACP can expose the same existing conversation surfaces as other Agents without flattening Core,
Runtime and native identities. The detailed contract lives in [ACP Agent behavior](../product-specs/acp-agent-behavior.md).
Third-party installation provenance and supported platforms are stated according to verified evidence.
Full-access native permission approval and exact connection retirement remain governed by ADR 0068.
