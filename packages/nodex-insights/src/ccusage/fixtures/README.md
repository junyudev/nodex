# ccusage v20.1.2 fixtures

These JSON excerpts use the synthetic fixture matrix at tag `v20.1.2` (`1697efa`). All snapshot paths below are relative to `rust/crates/ccusage/tests/snapshots/` in ccusage.

- `daily-by-agent.json` keeps selected days and agent rows from `golden__all__daily__json_by_agent.snap`. The day counters and model breakdowns roll up only the selected agents. Session identifiers and metadata come from `golden__all__daily__json_sections.snap`.
- `no-cost.json` keeps the April 21 row from `golden__all__daily__json_no_cost.snap`, its Kimi agent from `golden__all__daily__json_by_agent.snap` with cost fields omitted, and the matching session identifier from `golden__all__session__json_no_cost.snap`.
