import type { CodexScheduledAutomationLaunch } from "@/lib/types";
import {
  createWorkbenchAutomationDraft,
  type WorkbenchAutomationDraft,
} from "./workbench-automation-draft";

export interface WorkbenchAutomationTemplate {
  id: string;
  iconName: string;
  name: string;
  prompt: string;
  rrule: string;
  /** Work that changes the repository asks in the Inbox first; reports run on their own. */
  launch?: CodexScheduledAutomationLaunch;
}

export const WORKBENCH_AUTOMATION_TEMPLATES: readonly WorkbenchAutomationTemplate[] = [
  {
    id: "daily-bug-scan",
    iconName: "ladybug",
    name: "Daily bug scan",
    prompt:
      "Scan recent commits (since the last run, or last 24h) for likely bugs and propose minimal fixes.\n\nGrounding rules:\n- Use ONLY concrete repo evidence (commit SHAs, PRs, file paths, diffs, failing tests, CI signals).\n- Do NOT invent bugs; if evidence is weak, say so and skip.\n- Prefer the smallest safe fix; avoid refactors and unrelated cleanup.",
    rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
  },
  {
    id: "bump-dependency-versions",
    iconName: "block-stack",
    name: "Bump dependency versions",
    prompt:
      "Bump outdated dependencies to their latest compatible versions, run the project's checks, and open one draft PR per ecosystem.\n\nRules:\n- Skip major upgrades unless they need no code changes; list the skipped ones with their breaking changes.\n- Keep each PR to version bumps and the minimal fixes they require.",
    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
    launch: "ask",
  },
  {
    id: "security-check",
    iconName: "checkmark-circle",
    name: "Security check",
    prompt:
      "Check dependencies and recent changes for known vulnerabilities, exposed secrets, and risky configuration.\n\nRules:\n- Report only findings you can confirm, with the advisory, file, or commit as evidence.\n- When something needs me, send it to my Inbox with what to do about it; otherwise finish with a one-line all-clear.",
    rrule: "FREQ=DAILY;BYHOUR=8;BYMINUTE=0",
  },
  {
    id: "weekly-release-notes",
    iconName: "book-open",
    name: "Weekly release notes",
    prompt:
      "Draft weekly release notes from merged PRs (include links when available).\n\nScope & grounding:\n- Stay strictly within the repo history for the week; do not add extra sections beyond what the data supports.\n- Use PR numbers/titles; avoid claims about impact unless supported by PR description/tests/metrics in repo.",
    rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0",
  },
  {
    id: "daily-standup",
    iconName: "bubble-on-bubble",
    name: "Standup summary",
    prompt:
      "Summarize yesterday's git activity for standup.\n\nGrounding rules:\n- Anchor statements to commits/PRs/files; do not speculate about intent or future work.\n- Keep it scannable and team-ready.",
    rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0",
  },
  {
    id: "nightly-ci-report",
    iconName: "radar",
    name: "Nightly CI report",
    prompt:
      'Summarize CI failures and flaky tests from the last CI window; suggest top fixes.\n\nGrounding rules:\n- Cite specific jobs, tests, error messages, or log snippets when available.\n- Avoid overconfident root-cause claims; separate "observed" vs "suspected."',
    rrule: "FREQ=DAILY;BYHOUR=21;BYMINUTE=0",
  },
  {
    id: "daily-classic-game",
    iconName: "star-app",
    name: "Daily classic game",
    prompt:
      "Create a small classic game with minimal scope.\n\nConstraints:\n- Do NOT add extra features, styling systems, content, or new dependencies unless required.\n- Reuse existing repo tooling and patterns.",
    rrule: "FREQ=DAILY;BYHOUR=14;BYMINUTE=0",
  },
  {
    id: "skill-progression-map",
    iconName: "hierarchy",
    name: "Skill progression map",
    prompt:
      "From recent PRs and reviews, suggest next skills to deepen.\n\nGrounding rules:\n- Anchor each suggestion to concrete evidence (PR themes, review comments, recurring issues).\n- Avoid generic advice; make each recommendation actionable and specific.",
    rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=10;BYMINUTE=0",
  },
  {
    id: "weekly-engineering-summary",
    iconName: "figure-text-document",
    name: "Weekly engineering summary",
    prompt:
      "Synthesize this week's PRs, rollouts, incidents, and reviews into a weekly update.\n\nGrounding rules:\n- Do not invent events; if data is missing, say that briefly.\n- Prefer concrete references (PR #, incident ID, rollout note, file path) where available.",
    rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0",
  },
  {
    id: "performance-regression-watch",
    iconName: "bar-chart",
    name: "Performance regression watch",
    prompt:
      'Compare recent changes to benchmarks or traces and flag regressions early.\n\nGrounding rules:\n- Ground claims in measurable signals (benchmarks, traces, timings, flamegraphs).\n- If measurements are unavailable, state "No measurements found" rather than guessing.',
    rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
  },
  {
    id: "dependency-sdk-drift",
    iconName: "checkmark-circle",
    name: "Dependency and SDK drift",
    prompt:
      "Detect dependency and SDK drift and propose a minimal alignment plan.\n\nGrounding rules:\n- Cite current and target versions from the repo when possible (lockfiles, package manifests).\n- Do not guess versions; if targets are unclear, propose options and label them as suggestions.",
    rrule: "FREQ=DAILY;BYHOUR=11;BYMINUTE=0",
  },
  {
    id: "test-gap-detection",
    iconName: "puzzle",
    name: "Test gap detection",
    prompt:
      "Identify untested paths from recent changes; add focused tests and use $yeet for draft PRs.\n\nConstraints:\n- Keep scope tight to the changed areas; avoid broad refactors.\n- Prefer small, reliable tests that fail before and pass after.",
    rrule: "FREQ=DAILY;BYHOUR=15;BYMINUTE=0",
    launch: "ask",
  },
  {
    id: "pre-release-check",
    iconName: "checkmark-circle",
    name: "Pre-release check",
    prompt:
      'Before tagging, verify changelog, migrations, feature flags, and tests.\n\nGrounding rules:\n- Report ONLY what you can confirm from the repo and CI context.\n- If a check cannot be verified, mark it explicitly as "Unknown."',
    rrule: "FREQ=WEEKLY;BYDAY=TH;BYHOUR=13;BYMINUTE=0",
  },
  {
    id: "agents-docs-sync",
    iconName: "text-document",
    name: "Update AGENTS.md",
    prompt:
      "Update AGENTS.md with newly discovered workflows and commands.\n\nConstraints:\n- Keep edits minimal, accurate, and grounded in repo usage.\n- Do not touch unrelated sections or auto-generated files.\n- If you are unsure, prefer adding a TODO with a short note rather than inventing.",
    rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=11;BYMINUTE=0",
    launch: "ask",
  },
  {
    id: "weekly-pr-summary",
    iconName: "newspaper",
    name: "Weekly PR summary",
    prompt:
      "Summarize last week's PRs by teammate and theme; highlight risks.\n\nGrounding rules:\n- Use PR numbers/titles when available.\n- Avoid speculation about impact; stick to what the PR changed.",
    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0",
  },
  {
    id: "issue-triage",
    iconName: "exclamationmark-bubble",
    name: "Issue triage",
    prompt:
      'Triage new issues; suggest owner, priority, and labels.\n\nGrounding rules:\n- Base recommendations on issue content + repo context (CODEOWNERS, touched areas, prior similar issues).\n- Do not guess owners without signals; if unclear, say "Owner: Unknown" and suggest a team instead.',
    rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=30",
  },
  {
    id: "ci-monitor",
    iconName: "terminal",
    name: "CI monitor",
    prompt:
      'Check CI failures; group by likely root cause and suggest minimal fixes.\n\nGrounding rules:\n- Cite jobs, tests, errors, and log evidence.\n- Use supported CI integrations, skills, or authenticated command-line tools to access logs. Do not use browser or computer-use tools as a fallback.\n- If logs are inaccessible, ask the user to make a Buildkite API token available or install/enable the appropriate CI skill. Do not guess from check names alone.\n- Avoid overconfident root-cause claims; label uncertain items as "Suspected."',
    rrule: "FREQ=HOURLY;INTERVAL=2;BYMINUTE=0;BYDAY=MO,TU,WE,TH,FR",
  },
  {
    id: "dependency-sweep",
    iconName: "block-stack",
    name: "Dependency sweep",
    prompt:
      "Scan outdated dependencies; propose safe upgrades with minimal changes.\n\nRules:\n- Prefer the smallest viable upgrade set.\n- Explicitly call out breaking-change risks and required migrations.\n- Do not propose upgrades without identifying current versions from the repo.",
    rrule: "FREQ=HOURLY;INTERVAL=720;BYMINUTE=0;BYDAY=MO,TU,WE,TH,FR,SA,SU",
  },
  {
    id: "performance-audit",
    iconName: "compass",
    name: "Performance audit",
    prompt:
      "Audit performance regressions and propose highest-leverage fixes.\n\nGrounding rules:\n- Ground claims in measurements/traces when available.\n- If evidence is missing, state uncertainty briefly and suggest what to measure next.",
    rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=14;BYMINUTE=0",
  },
  {
    id: "changelog-update",
    iconName: "pencil",
    name: "Update changelog",
    prompt:
      "Update the changelog with this week's highlights and key PR links.\n\nConstraints:\n- Only include items supported by repo history.\n- Keep structure simple and consistent with existing changelog format.",
    rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=16;BYMINUTE=0",
    launch: "ask",
  },
] as const;

export function createWorkbenchAutomationDraftFromTemplate(
  template: WorkbenchAutomationTemplate,
): WorkbenchAutomationDraft {
  const draft = createWorkbenchAutomationDraft();
  return {
    ...draft,
    name: template.name,
    prompt: template.prompt,
    rrule: template.rrule,
    launch: template.launch ?? draft.launch,
  };
}
