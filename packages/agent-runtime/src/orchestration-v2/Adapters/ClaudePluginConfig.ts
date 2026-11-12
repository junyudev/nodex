import type { Settings } from "@anthropic-ai/claude-agent-sdk";

interface NativeClaudePlugin {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly managed?: boolean;
}

export function decideClaudeNativePluginOverrides(
  identities: readonly string[],
  nativePlugins: readonly NativeClaudePlugin[],
  hasLaunchSettings = false,
) {
  const duplicates = nativePlugins.filter(
    ({ name, enabled }) => enabled && identities.includes(name),
  );
  const conflict = duplicates.find(
    ({ id, managed }) =>
      managed ||
      hasLaunchSettings ||
      !/^[a-z0-9_.-]+@[a-z0-9_.-]+$/iu.test(id) ||
      /@(?:inline|skills-dir|synced|builtin)$/iu.test(id),
  );
  if (conflict) return { status: "conflict", identity: conflict.name } as const;
  const overrides: NonNullable<Settings["enabledPlugins"]> = Object.fromEntries(
    duplicates.map(({ id }) => [id, false]),
  );
  return { status: "ready", overrides } as const;
}
