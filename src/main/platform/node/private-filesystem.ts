/* @effect-diagnostics asyncFunction:off newPromise:off -- Native filesystem permissions are a Node Adapter boundary. */
import { chmod } from "node:fs/promises";
import { execFile } from "node:child_process";

interface PrivatePath {
  readonly path: string;
  readonly directory: boolean;
}

/** Core's one-shot platform command runs without a daemon, Store or shell. */
const nativePrivatePaths = (
  entries: readonly PrivatePath[],
  coreExecutable: string,
  verify: boolean,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = execFile(
      coreExecutable,
      ["--private-filesystem"],
      { windowsHide: true, timeout: 2_000, maxBuffer: 4096 },
      (error) => (error ? reject(error) : resolve()),
    );
    child.stdin!.once("error", reject);
    child.stdin!.end(JSON.stringify({ verify, entries }));
  });

/** Secure private files and inheritable directories with the native permission model. */
export const makePrivatePaths = async (
  entries: readonly PrivatePath[],
  coreExecutable: string,
): Promise<void> => {
  if (process.platform === "win32") return nativePrivatePaths(entries, coreExecutable, false);
  await Promise.all(entries.map((entry) => chmod(entry.path, entry.directory ? 0o700 : 0o600)));
};

/** Read the actual native owner and permissions without changing them. */
export const verifyPrivatePaths = (
  entries: readonly PrivatePath[],
  coreExecutable: string,
): Promise<void> => nativePrivatePaths(entries, coreExecutable, true);
