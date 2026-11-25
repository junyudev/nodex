/**
 * The variables a Nodex-owned provider declares: its own homes, credentials and settings. The
 * declaration never copies the host environment; Agent execution runs an isolated instance in the
 * host environment without the host's own provider variables, then applies these.
 */
export const declaredProviderEnvironment = (
  values: Readonly<Record<string, string>>,
  sensitive: readonly string[],
) =>
  Object.entries(values).map(([name, value]) => ({
    name,
    value,
    sensitive: sensitive.includes(name),
  }));
