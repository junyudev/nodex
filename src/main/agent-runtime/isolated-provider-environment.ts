/** Isolated launches keep shell/tool variables and use only their own provider credentials. */
const userProviderVariable =
  /^(?:OPENAI_|ANTHROPIC_|AZURE_OPENAI_|CODEX_|CLAUDE_)|^(?:CLAUDECODE|NODEX_GATEWAY_API_KEY)$/iu;

export function isolatedProviderEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string>>,
  sensitive: readonly string[],
) {
  const base = Object.fromEntries(
    Object.entries(inherited).flatMap(([name, value]) =>
      value === undefined || userProviderVariable.test(name) ? [] : [[name, value]],
    ),
  );
  return Object.entries({ ...base, ...overrides }).map(([name, value]) => ({
    name,
    value,
    sensitive: sensitive.includes(name),
  }));
}
