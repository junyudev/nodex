# Product Sense

## Who Nodex Serves
- Primary user: developers coordinating coding agents.
- Secondary user: humans reviewing and steering agent execution.

## Core Job To Be Done
Enable agents and humans to share one local source of truth for task state, with minimal operational overhead.

## Product Principles
- Local-first over cloud complexity.
- Agent-operable workflows via CLI/API, not UI-only actions.
- Fast feedback loops through real-time board updates.
- Portable data model (single DB + assets + backups).
- Keep multi-project isolation explicit and predictable.

## Decision Heuristics
When choosing between alternatives, prefer options that:
1. Preserve deterministic task operations for concurrent agents.
2. Keep data formats inspectable and recoverable by users.
3. Reduce coordination cost between board UI, CLI, and API.
4. Avoid introducing remote infrastructure dependencies.

## Non-Goals
- Multi-tenant cloud collaboration.
- Mobile-first UX optimization.
- Highly automated workflow orchestration at the cost of legibility.

## Feature Source of Truth
Use `docs/product-specs/nodex-product-spec.md` for complete feature contracts and API behaviors.
