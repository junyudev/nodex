# ADR 0081: Sources and followed threads

Accepted 2026-11-06.

Work continues in external discussions after it starts in Nodex. Sources bring
those facts into existing work without turning every update into another routing
decision. Core owns the durable identities and effects; Main owns the network
and credential lifetime. This keeps desktop polling and a future team host on
one authority model.

Polling is the completeness baseline. Each repository establishes its first-enable
boundary before reading, retains overlap and validators independently of its
position, and commits semantic deduplication, thread observations, Trigger
routing and position together under configuration, position and lease fences.
Webhooks may accelerate observation later; notifications are not a complete event
source. Tokens remain in Main and are pinned to the verified CLI account.

A Follow connects a Page to an External thread as its origin, own PR or context.
Followed people's events reach its active chat once as untrusted Host continuation
input. Bots and CI wake open work only. This delivery honors holds and Runtime
admission and performs no new assessment. Frozen targets and Runtime receipts
prevent restart or a lost response from repeating accepted input. Missing
active chats become Problems; only an explicit work decision supplies their first
destination. Unfollowed assignment, review-request and mention discovery enters
Inbox intake without consent to start work.

Only the Page's verified own PR supplies milestones. Opening a non-draft PR or
marking it ready moves In Progress to In Review; merging moves In Progress or
In Review to Done; closing unmerged cancels unfinished work; effective changes
requested moves In Review to In Progress. Person fences and observed ordering
protect newer decisions. Context and origin threads never move Status. Moves
and skipped moves retain their reasons.

Nodex replies through a frozen Channel outbox addressed only to the Page's
origin. One sender lease and per-thread order cover body, hash, episode and
marker. Unknown outcomes require complete marker reconciliation before another
POST. Permanent failures retain their original address and evidence; disabled
Sources pause sends. Suppression recognizes recorded markers or comment ids,
never the account, because Nodex shares the person's GitHub account.

One durable Problem lifecycle covers Source, Delivery, Channel and credential
failure. Open problems join the ordinary Inbox projection with one fix. Activity
is a rebuildable, bounded projection over committed decisions and effects,
including recovery. Members may read Activity and use person Retry actions;
source producers, sender internals and settlement retain Host authority. Origin
replies require the Coordinator's live Agent provenance.

behavior contracts are [Sources](../product-specs/sources-behavior.md) and
[Inbox](../product-specs/inbox-behavior.md).
