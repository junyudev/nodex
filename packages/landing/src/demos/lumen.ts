/**
 * The fictional workspace every demo shares: one product, three Projects, one burst of Inbox
 * messages. Agent and model names match what Nodex offers today; change them here when the
 * catalog moves on.
 */

import type { PageFolder } from "../replica/Page";

export type ProviderKind = "codex" | "claude" | "opencode";

export interface AgentChoice {
  readonly provider: ProviderKind;
  readonly model: string;
  readonly effort: string;
  /** The model is offered without a paid plan. */
  readonly free?: boolean;
}

export const AGENTS = {
  opus: { provider: "claude", model: "Claude Opus 5.5", effort: "High" },
  sol: { provider: "codex", model: "GPT-6.1 Sol", effort: "Extra High" },
  solHigh: { provider: "codex", model: "GPT-6.1 Sol", effort: "High" },
  deepseek: { provider: "opencode", model: "DeepSeek V4.1 Flash Free", effort: "High", free: true },
  glm: { provider: "opencode", model: "GLM-5.3-Flash Free", effort: "High", free: true },
} as const satisfies Record<string, AgentChoice>;

/** One entry in the model menu, in the order the menu lists them. */
export interface CatalogModel {
  readonly name: string;
  readonly provider: ProviderKind;
  readonly free?: boolean;
}

export const MODEL_CATALOG: readonly CatalogModel[] = [
  { name: "GPT-6.1 Sol", provider: "codex" },
  { name: "GPT-6 Astra", provider: "codex" },
  { name: "GPT-6.1 Terra", provider: "codex" },
  { name: "GPT-6 Sol", provider: "codex" },
  { name: "GPT-6 Luna", provider: "codex" },
  { name: "GPT-5.6 Sol", provider: "codex" },
  { name: "GPT-5.6 Terra", provider: "codex" },
  { name: "GPT-5.6 Luna", provider: "codex" },
  { name: "Claude Opus 5.5", provider: "claude" },
  { name: "Claude Sonnet 5.5", provider: "claude" },
  { name: "Claude Fable 5.1", provider: "claude" },
  { name: "Beam Free", provider: "opencode", free: true },
  { name: "DeepSeek V4.1 Flash Free", provider: "opencode", free: true },
  { name: "Flint 40B Free", provider: "opencode", free: true },
  { name: "GLM-5.3-Flash Free", provider: "opencode", free: true },
  { name: "MiMo-V2.6-Flash Free", provider: "opencode", free: true },
  { name: "Nemotron 3 Ultra Free", provider: "opencode", free: true },
  { name: "Nemotron 3.5 Lightning Free", provider: "opencode", free: true },
  { name: "Nemotron 3.5 Super VL Free", provider: "opencode", free: true },
];

/** What is left of each paid plan's weekly budget, as the rail's meters and the Inbox read it. */
export const WEEKLY_LEFT = { claude: 0.62, codex: 0.71 } as const;

/** The reader's own Inbox routing preferences, which outrank Nodex's model guide. */
export const ROUTING_PREFERENCES =
  "Docs and changelogs go to free models. Investigations stay read-only.";

export const PROVIDER_NAMES: Record<ProviderKind, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
};

export const PROJECTS = ["lumen-web", "lumen-api", "docs"] as const;
export type ProjectName = (typeof PROJECTS)[number];

export interface Delegate {
  readonly work: string;
  readonly agent: AgentChoice;
}

export type Dispatch =
  | {
      readonly kind: "new_chat";
      readonly project: ProjectName;
      readonly prompt: string;
      readonly agent: AgentChoice;
      readonly delegates?: readonly Delegate[];
      readonly plan?: string;
      /** The chat's title once it starts. */
      readonly chat: string;
    }
  | {
      readonly kind: "send_to_chat";
      readonly chat: string;
      readonly project: ProjectName;
      readonly prompt: string;
    }
  | { readonly kind: "keep"; readonly summary: string };

export interface InboxMessage {
  readonly id: string;
  readonly key: string;
  readonly text: string;
  readonly dispatch: Dispatch;
}

export const INBOX_BURST: readonly InboxMessage[] = [
  {
    id: "passkeys",
    key: "LUM-41",
    text: "Migrate sign-in to passkeys. Keep passwords as a fallback for one release.",
    dispatch: {
      kind: "new_chat",
      project: "lumen-web",
      chat: "Passkey sign-in",
      agent: AGENTS.opus,
      prompt:
        "Replace password sign-in with passkeys across web and API, keeping passwords as a fallback for one release.",
      delegates: [
        { work: "WebAuthn routes and challenge store", agent: AGENTS.sol },
        { work: "Credentials table migration and backfill", agent: AGENTS.solHigh },
        { work: "End-to-end tests for both sign-in paths", agent: AGENTS.solHigh },
        { work: "Docs for passkeys and the password fallback", agent: AGENTS.glm },
      ],
      plan: "Lead the UI and session flow yourself; merge the delegated parts behind one flag.",
    },
  },
  {
    id: "webhooks",
    key: "LUM-42",
    text: "Stripe webhooks double-charge when retries overlap",
    dispatch: {
      kind: "new_chat",
      project: "lumen-api",
      chat: "Idempotent Stripe webhooks",
      agent: AGENTS.sol,
      prompt:
        "Find why overlapping Stripe retries charge twice, make the handler idempotent, and add a regression test.",
    },
  },
  {
    id: "coldstart",
    key: "LUM-43",
    text: "why is dashboard cold start 2.3s?",
    dispatch: {
      kind: "new_chat",
      project: "lumen-web",
      chat: "Dashboard cold start",
      agent: AGENTS.deepseek,
      prompt:
        "Profile the dashboard's cold start and report the three biggest costs. Don't change code.",
    },
  },
  {
    id: "darkmode",
    key: "LUM-44",
    text: "settings dark mode looks washed out",
    dispatch: {
      kind: "send_to_chat",
      chat: "Settings redesign",
      project: "lumen-web",
      prompt:
        "Settings in dark mode looks washed out. Check contrast on surfaces and secondary text.",
    },
  },
  {
    id: "digest",
    key: "LUM-45",
    text: "idea: weekly digest email for workspace owners",
    dispatch: { kind: "keep", summary: "Keep as a note — an idea, not work to start yet." },
  },
  {
    id: "changelog",
    key: "DOC-12",
    text: "draft the v2.4 changelog from merged PRs",
    dispatch: {
      kind: "new_chat",
      project: "docs",
      chat: "v2.4 changelog",
      agent: AGENTS.glm,
      prompt:
        "Draft the v2.4 changelog from PRs merged since v2.3, grouped by Added, Changed and Fixed.",
    },
  },
];

/** The decision button's label, as the Inbox writes it. */
export function decisionLabel(dispatch: Dispatch): string {
  switch (dispatch.kind) {
    case "new_chat":
      return `New chat in ${dispatch.project}`;
    case "send_to_chat":
      return `Send to “${dispatch.chat}”`;
    case "keep":
      return "Keep";
  }
}

/** What the card says once the decision is made, before it folds away. */
export function outcomeLabel(dispatch: Dispatch): string {
  switch (dispatch.kind) {
    case "new_chat":
      return `Starting a chat in ${dispatch.project}`;
    case "send_to_chat":
      return `Sending to “${dispatch.chat}”`;
    case "keep":
      return "Kept as note";
  }
}

export const agentLine = (agent: AgentChoice) => `${agent.model} · ${agent.effort}`;

/** The passkey chat's delegated parts, as its transcript names them. */
export const PASSKEY_SUBAGENTS = [
  {
    name: "WebAuthn routes",
    avatar: "04-aperture",
    agent: AGENTS.sol,
    objective: "Add registration and assertion routes with a 5-minute challenge store.",
  },
  {
    name: "Credentials migration",
    avatar: "06-cube",
    agent: AGENTS.solHigh,
    objective: "Create the credentials table and backfill existing accounts.",
  },
  {
    name: "Sign-in tests",
    avatar: "19-whirl",
    agent: AGENTS.solHigh,
    objective: "Cover passkey and password sign-in end to end.",
  },
  {
    name: "Passkey docs",
    avatar: "00-marigold",
    agent: AGENTS.glm,
    objective: "Document passkey sign-in and the one-release password fallback.",
  },
] as const;

/**
 * What the cold-start chat finds and attaches to its Page. Durations keep a non-breaking space
 * so a unit never wraps onto its own line.
 */
export const COLD_START_FINDINGS = [
  "Hydrating the whole workspace tree before first paint — 1.1\u00a0s",
  "Charts bundle isn’t split (840\u00a0KB) — 0.6\u00a0s",
  "Font request blocks render — 0.3\u00a0s",
] as const;

export const COLD_START_FILES = [
  {
    name: "profile",
    files: [
      { name: "report.html", kind: "html", size: "14 KB" },
      { name: "flamegraph.png", kind: "image", size: "86 KB" },
      { name: "trace.json", kind: "json", size: "1.2 MB" },
    ],
  },
] as const satisfies readonly PageFolder[];
