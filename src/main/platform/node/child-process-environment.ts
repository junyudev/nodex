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
  "NODE_INSPECT_RESUME_ON_START",
  "VSCODE_INSPECTOR_OPTIONS",
  "__CFBUNDLEIDENTIFIER",
]);

// Debugger flags belong to the desktop process; every other Node option is the user's.
const INSPECTOR_OPTION = /^--(?:inspect(?:-brk|-wait|-port|-publish-uid)?|debug-port)(?:=.*)?$/u;

function withoutInspectorOptions(value: string): string | undefined {
  const options = value.split(/\s+/u).filter((option) => option && !INSPECTOR_OPTION.test(option));
  return options.length > 0 ? options.join(" ") : undefined;
}

/** User shells and tools must not inherit the desktop's runtime mode, inspector or crash pipes. */
export function childProcessEnvironment(environment: Environment, platform: string) {
  return Object.fromEntries(
    Object.entries(mergeProcessEnvironments(platform, environment)).flatMap(([name, value]) => {
      const key = name.toUpperCase();
      if (HOST_RUNTIME_VARIABLES.has(key)) return [];
      if (key !== "NODE_OPTIONS") return [[name, value]];
      const options = withoutInspectorOptions(value);
      return options ? [[name, options]] : [];
    }),
  );
}
