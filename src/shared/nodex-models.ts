/** The prepaid catalog is deliberately closed; gateway additions need an explicit product change. */
export const NODEX_MODELS = [
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", protocol: "openai" },
  { id: "gpt-6-luna", label: "GPT-6 Luna", protocol: "openai" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", protocol: "anthropic" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", protocol: "anthropic" },
] as const;
export const isNodexProviderId = (id: string): boolean =>
  /^nodex_(?:codex|claude)_[a-f0-9]{32}$/u.test(id);

/** Whole credits: a fraction of one is never shown as something left to spend. */
export const formatNodexCredits = (credits: number): string =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.trunc(credits) || 0);
