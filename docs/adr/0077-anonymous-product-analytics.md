# ADR 0077: Main owns anonymous product analytics behind a closed catalog

- Status: Accepted
- Date: 2026-11-07
- Owners: Nodex maintainers
- Relates to: [ADR 0048](0048-effect-main-application-kernel.md), [ADR 0068](0068-agent-runtime-execution-authority.md)

## Context

We could not answer how many people install Nodex, how many use it each day, or how many
conversations they start. Analytics existed only as a renderer SDK that was off by default and
never mentioned on first launch, so almost nobody opted in and the few who did were not
representative. Its events described request performance rather than product use. It sent no
identity, so the active-user and retention metrics in the analytics service stayed empty. Execution
facts could not reach it at all: local Threads and turns belong to the Agent Runtime, whose analytics
hook discarded everything.

Sharing has to be on by default to answer these questions, and that raises the bar for what can be
shared: a person must be able to see and stop it, and content must be unable to leak by construction
rather than by scrubbing.

## Decision

Electron Main owns one `ProductAnalytics` Module and it is the only network exit for analytics.

- **Closed catalog.** `src/shared/product-analytics/catalog.ts` is the complete vocabulary. Events
  decode strictly at the Main boundary: unknown events and fields are discarded, and free-form
  values cannot fit the code fields. There is no scrubber because there is no field for content.
- **Trust boundaries.** A renderer can report only window events. The Agent Runtime holds no client:
  it sends named execution facts over its private pipe, and Main maps them into the catalog. The
  distinction is typed, so a renderer cannot claim an installation or a Thread.
- **Authoritative sources.** Threads and turns are reported from the Runtime's committed domain
  events, so Agents, the CLI, automations and phones count the same way. Imported history is excluded.
- **Identity.** A random installation ID lives in the Profile and is sent as the analytics user ID.
  It is never linked to a Nodex account.
- **Consent.** Usage analytics and crash reports default on in released builds. Development builds,
  CI and `DO_NOT_TRACK` stay silent, and an environment override always wins. Main keeps events in a
  bounded local outbox and sends nothing until the first-launch notice has been on screen long enough
  to act on. Turning analytics off applies immediately and discards what has not been sent. Session
  replay stays opt-in: it records the screen, even masked, which a person should choose.
- **Transparency.** Settings shows the exact records sent and waiting.
- **Statsig over HTTP.** Statsig's public client key and event API are the whole integration. Main
  needs no SDK for this, and the renderer SDK and web-analytics plugin are removed.
- **Dashboards are code.** `scripts/analytics/product-dashboard.ts` defines the dashboard and
  `analytics:provision` converges it, so a metric's definition is reviewed with the event it reads.

## Consequences

Metrics exist for released builds from the first launch of this version onward, and earlier versions
remain visible only through distribution signals. A change to what is reported is a catalog diff in
review, and the privacy page and product specification change with it. A person's IP address still
reaches the service as with any request, which is disclosed. Installation means one Profile on one
computer, so a person with two Profiles counts twice.

Website counts and GitHub or update-feed totals share the dashboard through the stable-ID unit, so
they cannot inflate active installations. They cannot be joined to installations either, so the
website-to-install funnel is read side by side rather than per person.

## Alternatives considered

A first-party ingest service would hide IP addresses from the vendor and allow changing vendors
without a release, at the cost of running a service and rebuilding retention and funnels. The
`ProductAnalytics` transport is one function, so that path stays open if it becomes worth its cost.

Counting Threads from a Core table would need no Runtime change, but local Threads are Runtime-owned
and that table does not see all of them.
