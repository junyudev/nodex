import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function rolloutFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return rolloutFiles(file);
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [file] : [];
    }),
  );
  return files.flat();
}

/** Preserve the exact native log, independently of the temporary development Profile. */
export async function archiveConversation(codexHome: string, threadId: string, output: string) {
  const files = await rolloutFiles(path.join(codexHome, "sessions"));
  for (const source of files) {
    if (!path.basename(source).endsWith(`-${threadId}.jsonl`)) continue;
    const contents = await readFile(source);
    const firstLine = contents.subarray(
      0,
      contents.indexOf(10) < 0 ? contents.length : contents.indexOf(10),
    );
    const record = JSON.parse(firstLine.toString("utf8")) as {
      type?: string;
      payload?: { id?: string };
    };
    if (record.type !== "session_meta" || record.payload?.id !== threadId) continue;
    const archive = {
      file: "conversation.jsonl",
      threadId,
      source,
      capturedAt: new Date().toISOString(),
      bytes: contents.length,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
    await writeFile(path.join(output, archive.file), contents, { mode: 0o600 });
    await writeFile(
      path.join(output, "conversation.metadata.json"),
      JSON.stringify(archive, null, 2),
      {
        mode: 0o600,
      },
    );
    return archive;
  }
  throw new Error(`No native conversation log found for evaluation task ${threadId}`);
}
