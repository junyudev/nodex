# Composer prediction behavior

Composer predictions suggest a next user message for a ready root Codex Thread. They default
enabled through a Main-owned Profile preference, with a built-in prompt and optional host
overrides. The configuration boundary and sampling fields are documented in
[Configuration](../CONFIGURATION.md#composer-prediction-assignments).

## Generation and lifetime

A successful root Run completion requests a live prediction through Main's existing Session
activity projection, even when its Composer is not mounted. This uses the completion's exact
Runtime connection and never starts a cold Runtime. Failed, interrupted, archived, delegated,
or still-busy conversations do not generate a follow-up. A ready, connected, idle Composer
can request the same latest successfully completed Turn through catch-up; reopening a failed or
interrupted reply does not generate a suggestion. Background generation does not require an empty editor. Side Chats,
ephemeral Threads and unsupported conversation modes do not generate predictions.

Agent Runtime owns local prediction requests and helper calls on the Session's managed
native connection; Main owns predictions for explicitly attached remote conversations.
Each owner caches one request per source Thread and latest completed work: a local Run
or a remote native Turn. Shared callers reuse that request and its successful result
only while the same physical source is current; replacing a source invalidates reuse
even when its generation number is unchanged. Unsampled local requests remain cold
and cache their empty result without opening a Provider connection.
Failures do not retry automatically, but a later
explicit request can try again. Changing the latest Turn
removes the old request. A new parent Turn, host generation retirement, account mutation,
logout, authentication failure or explicit clear cancels pending work and invalidates
cached results. Configuration availability is local and does not start a connection.
Cancellation also covers configuration and authentication waits before a request
enters the cache, so disabling predictions or replacing an account cannot create a late helper.
Local cancellation also retires replacement requests waiting for an older helper's cleanup.
Scoped clears preserve requests admitted for unrelated hosts and Threads.

Generation first resumes the parent to obtain its effective model, provider, effort,
service tier and collaboration mode. Plan mode, non-OpenAI providers, excluded models and
unsupported native prediction forks return no suggestion. Eligible generation creates a
single ephemeral prediction fork, inheriting the parent's effective configuration, tools,
environments and persisted history, with full execution and Profile content access.
It does not replace a failed fork with a fresh Thread. Its Turn supplies only the
prediction prompt, configured effort, trigger and client message identity. The helper
is hidden from normal Thread catalogs.

The response must contain a nullable `suggestion` string. Completed message text replaces
partial deltas, and the returned text is trimmed. Malformed output fails the prediction
without changing accepted Composer content. Completion can settle before the Turn-start
acknowledgement. Timeout, cancellation or failure interrupts an active helper Turn; every
terminal path unsubscribes the temporary Thread and releases its internal classification.
Cancellation during fork creation keeps release ownership until the fork acknowledgement
identifies its helper; that helper is released before the cancellation settles and never
starts a prediction Turn. Cancellation after Turn dispatch releases the helper immediately
and still interrupts an accepted Turn if its acknowledgement arrives later. The owning
process Scope retains that acknowledgement wait and closes it on process shutdown.

## Composer interaction

A prediction appears as an inert ghost document only when the Composer has one empty
paragraph, no active mention suggestion, no input-method composition, and no conflicting
pending request, attachments or voice input. Existing text is never overwritten.

Unmodified Tab, ArrowRight or Enter accepts the ghost into the ordinary Composer document
and moves selection to its end. Acceptance does not send a Turn; ordinary submission still
owns sending. Clicking the ghost focuses the editor. Input-method composition hides the
ghost until composition has settled. Thread, controller and latest-Turn changes discard
stale responses and release the decoration and mention resources.

Submitting suppresses catch-up for that source Turn in the current Composer.
Accepted text remains ordinary editable content. A subsequent successful submission records
whether that accepted text was edited or replaced; failed or queued sends do not become a
successful submission outcome.

**Settings → General → Composer → Show predictions** controls the Profile preference and
persists across restart. Main publishes successful changes to every window and clears every
host's prediction cache even when no Composer is mounted. Disabling it also hides its ghost
without changing Composer text. Clearing uses only a running execution process and never wakes
a stopped Runtime, even when it has saved history. Re-enabling allows catch-up on the current
completed work. Host- and Thread-scoped clear operations remain available. Same-text result metadata updates preserve
the existing decoration, and mention metadata uses the ordinary Composer mention pipeline.
