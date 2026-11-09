# ADR 0082: Automations replace Scheduled tasks

- Status: Accepted
- Date: 2026-11-06
- Owners: Nodex maintainers
- Supersedes: the entity model in [ADR 0073](0073-scheduled-runs-that-ask-in-the-inbox.md)

## Context

A clock schedule and an external event can both supply the condition for standing
Agent work. Maintaining a separate Scheduled task would give the same action two
configuration surfaces, authorization models and execution histories.

The Inbox already holds editable requests until a person decides to start them.
Its reviewed instructions, per-run Agent choice and stable retry identity remain
the authority for work that asks first.

## Decision

An Automation is a Core record scoped to a Project or the Space. It names its Member
Owner, a condition and action in plain language, an optional typed condition,
execution target, enabled or paused state, lifecycle and revision. A clock
condition retains its RRULE, explicit timezone and jitter salt. Heartbeats are
clock Automations whose target continues a stable Session.

The record is called an Automation because that is the name people recognize for
standing work they hand to Nodex, and it matches the Automation Module that owns it.
Every Automation has one mode, named for what it does:

- Dry run records what would happen, with its reason, without creating work.
- Ask first holds an editable decision in the Owner's Inbox.
- Run starts the action under the Owner's standing authority.

Only the Automation's Owner may change its mode or edit an Automation set to Run.
Removing the Owner retires their Automations and withdraws unstarted decisions while
retaining history. Members may edit
Automations set to Ask first or Dry run within their scope. An Agent carries exactly the
authority of the Member it acts for, so it may create and change Automations as that Member
could, Run included. Its instructions, not Core, keep it to Ask first unless the person asked
for unattended runs; a change only the Owner may make can be proposed for the Owner to apply.
Triggers, Pages, runbooks and external text are evidence or instructions,
never authorization to change the Automation.

An Automation decision records the immutable Trigger references, inputs, reason, frozen
action and authority, admission state and links to the proposal, Page and dispatch.
Clock Triggers use `clock:<automation>:<schedule revision>:<due instant>` as their semantic
identity. They are immutable records in `automation_clock_triggers`; GitHub Sources keep
their own validated provider and thread contract.

An Automation set to Ask first has at most one waiting decision. Later occurrences append Trigger
references while the clock advances. Confirming freezes the reviewed message and
Agent choice in Core and admits that decision to the Automation execution owner. Skip,
redirection and withdrawal settle it without dispatching work. Retry retains the
same dispatch, preparation, Session and message identities.

Main observes Core's due-work plan, materializes through fenced leases and executes
admitted decisions. Run now uses the same durable admission. Dry run never gains
an execution lease. Missed time records the outstanding overdue occurrence once
and advances past now. Runbooks are read at execution time; heartbeat eligibility,
busy and cooldown guards, exact-Turn cancellation and notification preferences
remain part of execution.

The forward migration retains definition, dispatch, run, held Inbox and lease
identities and terminal results before removing the Scheduled tables. There is
one writable Automation model and one execution path. Existing deep links redirect to
Automations; CLI and Agent interfaces use Automation contracts.

A Page's recurrence and reminders continue to schedule human work. They do not
start Agent work.

## Event Automations

The existing Coordinator supplies event judgement through a bounded durable
assessment protocol; Core owns per-thread serialization, immutable policy
snapshots, generation fences, coverage validation and admission. Source filters
narrow evidence without replacing the written condition and action. Followed
threads bypass assessment. New Triggers queue behind a delivered batch.

Read-only assessment uses retained Trigger/thread evidence, exact Automation snapshots,
related Pages, follows and earlier decisions. Submission covers every applicable
Automation, including negative judgements. A changed revision requeues the request.
Durable Host input and Runtime admission receipts preserve delivery identity;
the carrying Run starts the deadline and receives at most one follow-up.

Core coalesces equivalent actions and sends incompatible ones to Ask first. Dry run
records only, Ask first proposes to the Automation Owner, and Run creates and starts a Page
with an origin follow under that Owner's current standing grant. External text,
bots, CI and model output are evidence, never authority. Event actions use the
ordinary Page-start outbox, not clock execution leases.

## Consequences

Automations provides the configuration and decision history for standing Agent work.
The Inbox remains where Ask first decisions wait. Clock matching is deterministic and
needs no model assessment; Source conditions use the same decision history and mode authority with bounded
Coordinator judgement.

An Inbox execution proposal carries the decision identity and any reviewed Agent
override. Core resolves its frozen action and authority from the decision record.

See [Automations behavior](../product-specs/automations-behavior.md) for the public contract.
