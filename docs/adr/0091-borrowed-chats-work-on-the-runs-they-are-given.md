# ADR 0091: Borrowed chats work on the Runs they are given

## Status

Accepted. Refines [ADR 0079](0079-status-moves-on-facts-a-persons-move-wins.md).

## Decision

A Page can start a chat for its work or give an existing chat a message. A chat
started for the Page supplies execution and reports from its whole conversation.
A borrowed chat supplies execution for the Run that takes the message. A new
delivery for the Page replaces its earlier scope. A live reply can resume the
Run that asked the question. An explicit work report or declaration of the
Page’s own pull request in the active borrowed chat moves the scope to the
Run that made the claim.

Core records the delivery identity when it confirms the handoff. The execution
owner resolves that identity to the Run and the Host supplies the resulting
observation. Core can also record the reporting Run directly after verifying
its authority. The binding retains its scoped facts across later unrelated
chat activity.
Status edits by the person still win over automatic moves. Linked chats and
their live activity remain chat-wide.
