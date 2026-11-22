import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { LatestDurableTextWriter, writeDurableJson } from "./durable-json-file";

test("publishes and replaces restart-readable JSON without staging leftovers", async () => {
  const home = await mkdtemp(join(tmpdir(), "nodex-durable-json-"));
  try {
    const directory = join(home, "metadata");
    const file = join(directory, "state.json");
    await writeDurableJson(file, { revision: 1 }, 128);
    await writeDurableJson(file, { revision: 2 }, 128);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ revision: 2 });
    expect(await readdir(directory)).toEqual(["state.json"]);

    await expect(writeDurableJson(file, { value: "x".repeat(128) }, 128)).rejects.toThrow(
      "size limit",
    );
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ revision: 2 });
    expect(await readdir(directory)).toEqual(["state.json"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("persists the latest offer once, in the background, and retries a failed write", async () => {
  const home = await mkdtemp(join(tmpdir(), "nodex-durable-latest-"));
  try {
    const directory = join(home, "metadata");
    const file = join(directory, "state.json");
    // A file where the directory belongs makes every write fail until it is replaced.
    await writeFile(directory, "");
    const errors: unknown[] = [];
    const writer = new LatestDurableTextWriter({
      filePath: file,
      maxBytes: 128,
      delayMs: 60_000,
      onError: (error) => errors.push(error),
    });

    writer.offer("1");
    writer.offer("2");
    await expect(writer.flush()).rejects.toThrow();
    expect(errors).toHaveLength(1);

    await rm(directory);
    await mkdir(directory);
    // The failed payload is kept for the next write.
    await writer.flush();
    expect(await readFile(file, "utf8")).toBe("2");

    writer.offer("3");
    writer.offer("4");
    // An offer returns before anything reaches the disk.
    expect(await readFile(file, "utf8")).toBe("2");
    await writer.flush();
    expect(await readFile(file, "utf8")).toBe("4");
    expect(await readdir(directory)).toEqual(["state.json"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
