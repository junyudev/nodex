import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const version = "2.1.4";
const tarballHash = "daa2fe04f27885090dccaeed9e0d6514bc80a7849ccb0a9d94521b383851bfa5";
const binaryHash = "d8a65dd253dbea759ae0dd829792ff219b40178c7decffea822430a4d1ccadb3";

async function fileHash(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function prepareOpenCodeDesktopToolsBinary(): Promise<string | undefined> {
  const gitDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    encoding: "utf8",
  }).trim();
  const cache = path.resolve(gitDir, "../cache.local/opencode-e2e");
  const binary = path.join(cache, `opencode-darwin-arm64-${version}`);
  if (existsSync(binary)) {
    if ((await fileHash(binary)) !== binaryHash)
      throw new Error("Cached OpenCode binary hash mismatch");
    return binary;
  }
  const url = `https://registry.npmjs.org/@opencode/cli-darwin-arm64/-/cli-darwin-arm64-${version}.tgz`;
  const archive = await fetch(url, { signal: AbortSignal.timeout(60_000) }).then(
    async (response) => {
      if (!response.ok)
        throw new Error(`OpenCode fixture download returned HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    },
    () => undefined,
  );
  if (!archive) return undefined;
  if (createHash("sha256").update(archive).digest("hex") !== tarballHash)
    throw new Error("OpenCode tarball hash mismatch");
  await mkdir(cache, { recursive: true });
  const scratch = await mkdtemp(path.join(cache, ".extract-"));
  try {
    const tarball = path.join(scratch, "opencode.tgz");
    await writeFile(tarball, archive);
    execFileSync("tar", ["-xf", tarball, "-C", scratch, "package/bin/opencode"]);
    const extracted = path.join(scratch, "package/bin/opencode");
    if ((await fileHash(extracted)) !== binaryHash)
      throw new Error("Extracted OpenCode hash mismatch");
    await chmod(extracted, 0o755);
    await rename(extracted, binary);
    return binary;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
