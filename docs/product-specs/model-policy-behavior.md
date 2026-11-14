# Model policy

Model policy is a Profile setting. A model is either on or off. Settings and search may
retain off models; their presence in a catalog does not grant execution permission.
Conversation history remains readable with its original account and model binding.

## Choices and identity

The Profile stores provider switches and exceptions to each provider's model default.
Every provider defaults on. OpenCode's models default off, free ones included, because third
parties run them on their own terms; every other model defaults on. Switching a provider off preserves its model exceptions.
New models follow the provider default. Nodex has one provider switch; its model keys
contain the Runtime driver and exact model ID, independent of the signed-in account.
Other keys contain the configured instance and exact model ID. Changing accounts never
moves an existing conversation onto the new account.

`agentsMayChooseCredit` defaults to false. The meter's `usageMeters.nodexCredit` preference
is independent and grants no model access.

| Initiator                                  | On models        | Off models | Nodex credit                     |
| ------------------------------------------ | ---------------- | ---------- | -------------------------------- |
| Person, including explicitly saved choices | Allowed          | Refused    | Allowed                          |
| Agent executing on Nodex                   | Allowed          | Refused    | Allowed                          |
| Agent executing elsewhere                  | Allowed          | Refused    | Requires `agentsMayChooseCredit` |
| Automatic model selection                  | Skips off models | Skipped    | Never chosen                     |

No forbidden explicit choice is silently replaced. Driver-only delegation, another
instance's first-model selection, planner candidates, Mobile fallback, Refine fallback,
automation first-model selection, and native-import fallback exclude Nodex credit.
Runtime source-control utilities resolve their automatic defaults from on, non-credit models,
including when a Project's default is off. A chat's default title model comes from the chat's own
Agent, uses only on models, and never moves a credit chat to a model the person did not choose.
A saved exact model remains an explicit choice, including when it has been switched off.

## Settings and pickers

Settings → Models lists Nodex first and open, then one closed card per other provider with
its count (`8 of 13 on`). Each card has a provider switch; opening one shows its models with
their own switches and whole-list moves (All on, All off, and Free only for OpenCode). A
filter field narrows every card and opens those it matches. A discounted Nodex model carries
its rate mark, as in Model prices. Nodex also offers **Let Agents choose Nodex models**, and
links to its prices and Top up.

An off provider is one quiet line, and turning it back on restores each model's own switch.
With Nodex off the card reads `Off. Nothing on this computer can spend your credits.`

A model picker lists only models that are on. The composer's picker adds a row counting what
is off, which opens Settings → Models, and its gear opens the same page. Searching also finds
off models, dimmed and marked `Off`: choosing one turns it on and selects it, except that a
Nodex model opens its Settings card instead, because spending credits is a deliberate choice.
A whole provider that is off returns only from Settings. Other pickers, such as Inbox,
Automations, the chat title model and a Page's agent configuration, list on models and keep a
saved choice visible.

A chat whose model is off keeps showing it, marked `Off`, and raises a composer notice naming
the model with **Choose model**, and **Turn on** or, for Nodex and an off provider, **Manage**.

When a change would stop running work, Settings asks first, naming the models and how many
chats stop. The confirmation also says so when a Claude chat on an allowed model stops,
because Nodex Claude chats restart together.

## Execution authority

Main persists the policy in the Profile's `config.toml` and broadcasts canonical changes
to every window. The private Runtime bootstrap and live configuration carry it to one
Runtime policy owner. Each Run retains the origin of its model choice, which is checked
again when queued or retained work starts. Calling Run identity, rather than a next-turn
model change, determines an Agent's credit authority. Policy changes bypass deferred
provider configuration and Project overrides cannot widen them. Policy assertions require an
explicit origin. Missing historical continuation authority fails closed for Nodex credit.

The Runtime checks new message and delegated-task admission, provider-session opening,
provider turn start, queue promotion, retries and recovery, compaction, steering, native
interaction controls, and every text-generation method. The same admission covers
composer sends, Session tools, task follow-ups and automation dispatch. Main checks
Session launch before creating its product binding and checks Agent automation model
choices before saving them. Native policy restrictions supplement these boundaries;
they do not replace them.

Agent answers to live questions, information requests and plan questions carry the answering
Thread and Run, including delegated-task questions and message-based replies. Intake checks
the model of the executing Run, even if the chat's next-turn choice has changed. Agents cannot
answer execution approvals. A person's answers remain allowed on an on model. Durable
response and steering effects retain the requester's authority and recheck it at the native
control boundary. Promoting a queued message uses the promoter's authority independently of
its original author; a steer that becomes a new turn retains that authority.

A handoff with a follow-up checks that follow-up before moving execution or recording a
handoff. The caller's Thread and Run survive the background operation and persisted recovery,
and admission checks them again when the follow-up is sent. Refusing the initial follow-up
leaves the handoff untouched. A later policy change can refuse a previously admitted follow-up
without reversing a handoff that has already completed. An older handoff that records a
requester without retaining its authority completes the move with a warning and requires
a manual follow-up; its Thread's current model cannot establish the original caller's authority.

Policy refusals are non-retryable:

- `model_off`: `GPT-6.1 Sol on Nodex is off in Settings → Models. Choose another model.`
- `credit_requires_person`: `Only the person can start Nodex models. Choose another provider.`

Errors retain these codes and actionable messages through Runtime transport, Session
tools, provider failures and rewrite generation. Off is distinct from sign-in, supply,
installation or transport unavailability.

## Applying changes

Turning Nodex off closes admission, cancels queued work before stopping active work,
closes native sessions and removes managed provider instances. The account remains signed
in; balance and account status reads keep working. Enabling Nodex restores declarations
for the current account. A Runtime that cannot confirm retirement within the bounded
retirement period is stopped.

Turning off a Nodex model cancels affected queued work and stops active work. Claude
captures managed restrictions per native process, so tightening its Nodex policy also
retires the existing managed Claude sessions, including allowed-model sessions on that
instance. New sessions receive the updated native policy. Codex sessions selected on the
disabled model are closed. Non-credit model changes leave current execution alone and
apply to the next turn.

Text utilities register their selected model with the Runtime policy owner. Disabling their
Nodex model cancels preparation and active generation and waits for owned native resources
to close. Every executing text provider rechecks policy after asynchronous preparation,
immediately before its CLI spawn, SDK query or OpenCode prompt submission. A non-credit
utility already in flight is allowed to finish; one still preparing must pass the final check.
Cancellation cannot retract requests already delivered to a provider.

The renderer's model-policy catalog includes every known model with effective on/off,
its own switch, provider on/off, stable policy key, and whether it spends credit. Live
credit work identifies the root conversation, executing Thread, model and instance; the
renderer joins roots to product Session IDs using the shared activity snapshot. Activity
and policy changes invalidate this query across windows. An incomplete activity snapshot
must not be treated as a complete list of affected chats.

## Native limits

Claude receives a managed exact `availableModels` list and `enforceAvailableModels`.
An off model is absent from the list, so turning off an older version leaves newer
versions in the same family available. The installed SDK's local settings resolver
checks that the list and its enforcement survive the settings merge before launch.
Missing or replaced policy refuses execution. A policy fingerprint prevents reusing a
process with old restrictions for a subsequent turn. Native text utilities receive the
same policy. Claude utilities stop if the SDK reports a different model before dispatch.
Utilities reject results when the CLI or the main response reports a different model.

This local check performs no inference. It checks the SDK's raw settings cascade, not
remote billing or the entire launched CLI's request stream. The SDK resolver does not run
an administrator's `policyHelper`; a reported helper therefore refuses launch. Environment-
scoped configuration and CLI/SDK differences remain limits of the local check. No paid
native-subagent or helper-request conformance is implied.

The pinned Codex runtime has no general per-model deny that covers all native agent-role
overrides. Nodex refuses its own work on off models, but an allowed Codex conversation's
native children can still select an off model on the parent's provider and credentials.
Nodex does not claim an exact request-level allowlist for that path. Native children of
another provider do not acquire Nodex's managed credentials merely by changing model ID.
Gateway per-key allowlists are outside this policy.

Requests already sent may already have incurred a charge. Stopping local execution cannot
reverse it.
