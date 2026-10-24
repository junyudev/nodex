// Keep this Node-only inventory usable by both TypeScript build tools and packaging hooks.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const agentRuntimeNativeInventory = (root) => {
  const files = [];
  const visit = (segments) => {
    const file = join(root, ...segments);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink())
      throw new Error(
        `Agent Runtime native dependency contains a link: ${file}`,
      );
    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) visit([...segments, name]);
      return;
    }
    if (!stat.isFile())
      throw new Error(
        `Agent Runtime native dependency is not a regular file: ${file}`,
      );
    files.push({
      path: segments.join("/"),
      size: stat.size,
      executable: (stat.mode & 0o111) !== 0,
      sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
    });
  };
  visit([]);
  return files;
};
export const agentRuntimeNativeDigest = (root) =>
  createHash("sha256")
    .update(JSON.stringify(agentRuntimeNativeInventory(root)))
    .digest("hex");
export const assertPackagedAgentRuntimeNative = ({
  sourceRoot,
  packagedRoot,
}) => {
  if (
    agentRuntimeNativeDigest(sourceRoot) !==
    agentRuntimeNativeDigest(packagedRoot)
  )
    throw new Error(
      "Packaged Agent Runtime native dependency differs from its verified build",
    );
};
