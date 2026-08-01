# Product Sense

## Who Nodex Serves

- Primary user: developers who use coding agents in real local projects.
- Secondary user: developers reviewing, steering, and resuming agent work over
  time.

## Core Job To Be Done

Help a developer and their coding agents work from the same durable context,
then keep that context visible beside execution and review.

## Product Thesis

A prompt is a handoff, not a durable workspace. Useful agent work depends on
goals, constraints, references, decisions, and acceptance criteria that should
remain inspectable after a chat turn ends.

In Nodex, Pages hold that shared working context. Projects place Pages beside
agent chats and the tools used to execute the work. The Library keeps Pages and
Databases available independently of any one Project or chat.

## Product Principles

- **Shared context over prompt reconstruction.** Make the relevant Page content
  easy to shape, select, send, revisit, and update.
- **Context beside execution.** Keep Page, chat, files, terminal, browser, and
  Review within the same Project workbench.
- **Agent-operable, not UI-only.** Let agents search, read, create, and update
  the same Pages through the native CLI and official Skill, with explicit authorization.
- **Visible state over hidden orchestration.** A developer should be able to see
  what context exists, what the agent is doing, and what changed.
- **Local-first ownership.** Keep Library and Project state in the local core,
  preserve user-owned source folders, and avoid requiring remote
  infrastructure.
- **Stable identity and explicit scope.** Preserve Page, Project, Session, and
  Thread identity while keeping access boundaries predictable.

## Decision Heuristics

When choosing between alternatives, prefer options that:

1. Reduce the work required to reconstruct task context across tools.
2. Keep context readable to both the developer and the agent.
3. Preserve Project scoping and explicit authorization for agent actions.
4. Keep execution and review reachable without turning the interface into a
   dashboard of duplicate status.
5. Strengthen local ownership, inspectability, and recovery.
6. Make the product model simpler rather than adding compatibility layers or
   speculative automation.

## Current Non-Goals

- Multi-tenant cloud collaboration.
- Mobile-first product editing or agent execution.
- Treating a folder of Markdown files as the complete Library source of truth.
- Automatically returning every agent result into the originating Page with
  provenance and lifecycle state before that behavior is implemented.
- Fully autonomous workflow orchestration that hides context, authorization, or
  review from the developer.

## Feature Source of Truth

Use `docs/product-specs/nodex-product-spec.md` for the product promise and
capability map, then follow its links to the narrow owning feature contracts
under `docs/product-specs/`. This document guides product tradeoffs; it does
not override implemented contracts.
