/* @effect-diagnostics asyncFunction:off newPromise:off -- Native filesystem permissions are a Node Adapter boundary. */
import { execFile } from "./child-stdio-errors";
import { chmod } from "node:fs/promises";

interface PrivatePath {
  readonly path: string;
  readonly directory: boolean;
}

/** Core's one-shot platform command runs without a daemon, Store or shell. */
const nativePrivatePaths = (coreExecutable: string, request: object): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      coreExecutable,
      ["--private-filesystem"],
      { windowsHide: true, timeout: 2_000, maxBuffer: 4096 },
      (error) => (error ? reject(error) : resolve()),
    );
    child.stdin!.end(JSON.stringify(request));
  });

/** Secure private files and inheritable directories with the native permission model. */
export const makePrivatePaths = async (
  entries: readonly PrivatePath[],
  coreExecutable: string,
): Promise<void> => {
  if (process.platform === "win32")
    return nativePrivatePaths(coreExecutable, { verify: false, entries });
  await Promise.all(entries.map((entry) => chmod(entry.path, entry.directory ? 0o700 : 0o600)));
};

/** Read the actual native owner and permissions without changing them. */
export const verifyPrivatePaths = (
  entries: readonly PrivatePath[],
  coreExecutable: string,
): Promise<void> => nativePrivatePaths(coreExecutable, { verify: true, entries });

/** Create or validate a private store from a trusted Profile directory on Windows. */
export const ensurePrivateDirectoryBoundary = (
  coreExecutable: string,
  profile: string,
  directory: string,
) => nativePrivatePaths(coreExecutable, { boundary: profile, directory, verifyDescendant: false });

export const verifyPrivateDirectoryDescendant = (
  coreExecutable: string,
  boundary: string,
  directory: string,
) => nativePrivatePaths(coreExecutable, { boundary, directory, verifyDescendant: true });
