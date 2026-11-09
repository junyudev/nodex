# ADR 0076: Nodex Mobile's runtime is an Effect application behind a presentation edge

- Status: Accepted
- Date: 2026-11-04
- Owners: Nodex maintainers
- Refines: the Effect frontier in [ADR 0047](0047-effect-control-plane-and-runtime-boundaries.md)
- Relates to: [ADR 0084](0084-phones-as-member-devices.md)

## Context

ADR 0047 gives Effect the work involving time, retry schedules, structured cancellation, queues,
connection barriers, ordered delivery and resource scopes, and keeps renderers Effect-free because
renderers only present. It was written for a desktop where Main does that work for the renderer.

A phone has no Main. Nodex Mobile's own process races pinned routes, renews Device sessions, reconnects
with backoff, follows chats, delivers a durable outbox in order, and downloads files with resume.
Written as promises, timers and abort signals, that coordination was correct only by convention:
each new path had to remember to cancel, and nothing checked it.

## Decision

`packages/mobile/src/runtime` is an Effect application root, held to the same architecture gate as
Main: scoped services, bounded queues, typed failures, and no ambient state or unstructured async.
One managed runtime in `runtime.ts` runs them.

Screens stay out of it. `packages/mobile/src/features`, `ui`, `markdown` and `navigation` are
Effect-free, as `@nodex/mobile-protocol` is. They use `runtime/index.ts`, which exposes hooks reading
atom projections and command functions returning promises. State that only a screen cares about,
such as a draft, is a small local store rather than an atom.

Promise and callback shapes exist only at the runtime's two frontiers: the bounded WebSocket adapters
in `pinned-tls.ts`, and Expo's modules in `expo-platform.ts`. See the
[external frontier ledger](../effect-external-frontiers.md).

## Consequences

- Cancellation and teardown are structural: closing a scope closes its sockets and stops its timers,
  and tests can assert that disposal leaves nothing running.
- The Hermes bundle grew from 5.77 MB to 8.09 MB, nearly all of it Effect's modules. Measured on an
  iOS simulator Release build under equal load, cold start did not regress: alternating runs gave a
  median of about 2.7 s before and 2.6 s after, within the 350 ms sampling interval.
- The promise edge is more code than a store would be, since the screens' surface stays plain. The
  implementation is about 12% larger than the promise version, in exchange for the gate's guarantees.
- A file sharing a base name with a `.native.ts` file resolves differently under Metro than under
  Vitest. Runtime code therefore avoids that pairing except for the one deliberate seam in
  `instance.native.ts`, which binds the real platform.
