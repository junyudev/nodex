import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { writeDurableJson } from "./durable-json-file";

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
