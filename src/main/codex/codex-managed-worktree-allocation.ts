import { randomUUID } from "node:crypto";
import * as path from "node:path";

/** Chooses an unused identity before a worker can create or move task files. */
export const allocateManagedWorktreePath = (managedRoot: string): string => {
  const now = new Date();
  const date = now.toISOString().slice(2, 10).replaceAll("-", "");
  const time = now.toISOString().slice(11, 16).replace(":", "");
  const join = path.posix.isAbsolute(managedRoot) ? path.posix.join : path.win32.join;
  return join(managedRoot, `${date}-${time}-${randomUUID().slice(0, 8)}`);
};
