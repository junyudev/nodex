/** Keep an Agent shell's Node mode from switching an Electron app launch into a Node process. */
export const electronApplicationEnvironment = (
  environment: NodeJS.ProcessEnv,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[0].toUpperCase() !== "ELECTRON_RUN_AS_NODE",
    ),
  );
