type Environment = Readonly<Record<string, string | undefined>>;

/** Later layers win, including removals. Windows has one variable per case-insensitive name. */
export function mergeProcessEnvironments(
  platform: string,
  ...environments: readonly Environment[]
): Record<string, string> {
  const entries = new Map<string, readonly [string, string]>();
  for (const environment of environments) {
    for (const [name, value] of Object.entries(environment)) {
      const key = platform === "win32" ? name.toUpperCase() : name;
      if (value === undefined) entries.delete(key);
      else entries.set(key, [key === "PATH" ? "PATH" : name, value]);
    }
  }
  return Object.fromEntries(entries.values());
}

const HOST_RUNTIME_VARIABLES = new Set([
  "BREAKPAD_DUMP_LOCATION",
  "CHROME_CRASHPAD_PIPE_NAME",
  "CRASHPAD_HANDLER_PID",
  "ELECTRON_CRASH_REPORTER_PROCESS_TYPE",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ASAR",
  "ELECTRON_ENABLE_LOGGING",
  "ELECTRON_LOG_FILE",
  "ELECTRON_ENABLE_STACK_DUMPING",
  "ELECTRON_RENDERER_URL",
  "NODE_OPTIONS",
  "NODE_INSPECT_RESUME_ON_START",
  "VSCODE_INSPECTOR_OPTIONS",
  "__CFBUNDLEIDENTIFIER",
]);

/** User shells and tools must not inherit the desktop's runtime mode, inspector or crash pipes. */
export function childProcessEnvironment(environment: Environment, platform: string) {
  return Object.fromEntries(
    Object.entries(mergeProcessEnvironments(platform, environment)).filter(
      ([name]) => !HOST_RUNTIME_VARIABLES.has(name.toUpperCase()),
    ),
  );
}
