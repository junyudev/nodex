/**
 * Electron arguments for every disposable launch: development instances, Electron E2E, and
 * integration fixtures. On macOS, AppKit's crash-restoration prompt appears before Electron is
 * ready whenever an earlier instance of the same bundle was killed, which blocks the next
 * window indefinitely. This process-only setting suppresses that prompt; Nodex still restores
 * its own windows and sessions, and global preferences are unchanged.
 */
export const isolatedElectronArguments = (
  platform: NodeJS.Platform = process.platform,
): readonly string[] => (platform === "darwin" ? ["-ApplePersistenceIgnoreState", "YES"] : []);
