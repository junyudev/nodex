Automations that react to GitHub events no longer take a schedule. Each Automation now has one
`trigger`: a clock with an RRULE and timezone, or GitHub events, which has no RRULE, timezone or
next run. Agents and `nodex automations create|update` put the schedule or event filter under
`trigger`, and the old top-level `rrule`, `timezone` and `source_condition` fields are refused
instead of silently replaced.
