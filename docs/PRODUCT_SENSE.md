# Product Sense

## Who Nodex Serves

- Primary user: developers coordinating coding agents, alone or as a team.
- Secondary user: people who ask for work, answer an Agent's questions and review its results without running Agents themselves.

## Core Job To Be Done

Let people and Agents share one source of truth for work, so that the right person or Agent acts at the right time, and nobody spends attention on work that does not need them.

## Product Principles

- **Attention is the budget.** Take as little of a person's attention as possible and give as much value as possible. Speak only when someone must act or can use a result.
- **One model for one person and for a team.** A personal Space is a team Space with one member; nothing works differently because of it.
- **Local-first ownership.** Every Space is one Core the user owns, on their own machine or on a machine their team controls.
- **Agent-operable workflows** through the CLI and API, not UI-only actions.
- **Fast feedback loops** through live updates of the Board, the Inbox and documents.
- **Portable data model**: one database, assets and backups per Space.
- **Explicit isolation**: each piece of Agent work runs in its own workspace, and Projects stay separate.

## Decision Heuristics

When choosing between alternatives, prefer options that:

1. Preserve deterministic work operations for concurrent people and Agents.
2. Keep data formats inspectable and recoverable by users.
3. Reduce coordination cost between the Board, the Inbox, the CLI and the API.
4. Never require infrastructure that Nodex operates: a team Space runs on a machine the team controls.
5. Make an automated step legible: who did it, why, and how to undo it.

## Non-Goals

- Hosted multi-tenant cloud service run by Nodex.
- Mobile-first UX optimization.
- Highly automated workflow orchestration at the cost of legibility.

## Feature Source of Truth

Use `docs/product-specs/nodex-product-spec.md` for the product promise and capability map, then follow its link to the narrow owning feature contract under `docs/product-specs/`.
