# Calendar and Reminders Behavior

## Availability

Calendar data, Page schedule editing, recurrence, occurrences, reminders, and
notification delivery remain supported independently of the Calendar renderer.
The visual Calendar presentation is behind the checked-in release gate while
its interaction design is being rebuilt. When disabled, existing Calendar Views
retain their identity and query but present through List; the gate never rewrites
their durable kind or configuration.

## Calendar presentation

When enabled, Calendar presents scheduled authorized Pages through occurrence
windows in Day, Week, custom Multi-Day, and custom Multi-Week ranges. It has one
all-day lane above the timed grid. Multi-day all-day occurrences span their
covered end-exclusive day range; timed occurrences participate in overlap-aware
lanes.

The range selector and previous/today/next controls live in the View toolbar.
The all-day lane is vertically scrollable and resizable with pointer and
keyboard. Timed hour height fits the available surface down to the minimum
readable density. Shift-wheel navigation gives immediate visual feedback and
commits the nearest complete day offset after the gesture settles.

Dragging moves an occurrence while preserving duration. Crossing between timed
and all-day lanes performs an explicit conversion: all-day ranges use local-day
boundaries, while a conversion back to timed uses the retained meaningful
duration or a one-hour fallback. Resize uses fifteen-minute slots. During a
gesture, only the eligible region displays the target preview; dropping outside
the Calendar changes nothing.

## Recurrence

Recurrence supports daily, weekly, monthly, and yearly frequency, positive
intervals, weekly weekdays, an optional inclusive end date, exceptions, and a
schedule timezone. Expansion preserves local wall-clock intent through daylight
saving transitions.

Changing a recurring occurrence requires an explicit scope:

- `Only this occurrence` detaches one standalone Page and records an exception
  in the original series.
- `This and future` ends the original series before the selected occurrence and
  creates a new series from that occurrence.
- `All occurrences` updates the current series.

The first occurrence does not offer a meaningless split; `This and future`
there behaves as `All occurrences`. Dragging a bounded series shifts its
inclusive end date by the same calendar-day delta so the series length remains
stable.

Complete, skip, and scoped update are idempotent commands with a caller-retained
operation identity. Retrying the same intent returns its first result; reusing
the identity for different intent is a typed collision. Commands that clone or
split preallocate the new Page identity and commit title, body, values,
schedule, exception, projection, and receipt atomically.

## Reminders and notifications

Reminder offsets are evaluated from current schedule authority and Page content.
The scheduler deduplicates a Page occurrence across Project presentation routes
and chooses an active Project context for delivery. Startup/resume catch-
up does not send the same logical reminder twice. Native notification authorization
is checked before presentation. A reminder blocked by system permission retains its
lease retry instead of being marked delivered. A reminder is marked delivered only
after Electron confirms native scheduling; native failure or closing before that
confirmation retains the retry.

Notification activation opens the exact Page. Snooze belongs to the requesting
Project and Page and validates their current identity and lifecycle. It expires
when that delivery context is no longer valid. A stale schedule index or stale Page materialization
fails closed rather than resurfacing legacy content.

Desktop notification suppression, payload, and activation rules live in
[Desktop Notification Behavior](desktop-notification-behavior.md). Scheduler,
lease, catch-up, and durability rules live in [Reliability](../RELIABILITY.md).
