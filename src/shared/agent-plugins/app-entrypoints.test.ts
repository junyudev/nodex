import { expect, test } from "vite-plus/test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { derivePluginAppEntrypoints, selectPluginAppEntries } from "./app-entrypoints";

function tool(name: string, entrypoints: unknown[]): Tool {
  return {
    name,
    inputSchema: { type: "object" },
    annotations: { title: "Annotated title" },
    _meta: { ui: { resourceUri: `ui://notes/${name}` }, "openai/ui": { entrypoints } },
  };
}

test("derives only supported app placements and ignores malformed extension declarations", () => {
  const entries = derivePluginAppEntrypoints("notes", [
    tool("open", [
      { type: "global" },
      { type: "global" },
      { type: "thread" },
      { type: "unknown" },
      { type: "file", extensions: [".txt", "invalid"] },
      { type: "file", extensions: [".Fieldnote", ".fieldnote", ".daily.note"] },
    ]),
    {
      name: "no-ui",
      inputSchema: { type: "object" },
      _meta: { "openai/ui": { entrypoints: [{ type: "global" }] } },
    },
  ]);
  expect(entries).toMatchObject([
    { id: '["notes","open","global"]', kind: "global", title: "Annotated title" },
    { id: '["notes","open","thread"]', kind: "thread" },
    { id: '["notes","open","file"]', kind: "file", extensions: [".daily.note", ".fieldnote"] },
  ]);
});

test("chooses the same entry within a plugin regardless of discovery order", () => {
  const tools = ["zulu", "alpha"].map((name) =>
    tool(name, [{ type: "global" }, { type: "file", extensions: [".note"] }]),
  );
  const entries = derivePluginAppEntrypoints("notes", tools);
  const catalog = ["one", "two"].flatMap((pluginId) =>
    entries.map((entry) => ({
      pluginId,
      pluginName: pluginId,
      entryTitle: entry.title,
      entry,
    })),
  );
  for (const target of [{ kind: "global" }, { kind: "file", name: "FIELD.NOTE" }] as const) {
    const chosen = selectPluginAppEntries(catalog, target);
    expect(chosen).toEqual(selectPluginAppEntries([...catalog].reverse(), target));
    expect(chosen.map(({ entry }) => entry.toolName)).toEqual(
      target.kind === "global" ? ["alpha", "zulu", "alpha", "zulu"] : ["alpha", "alpha"],
    );
  }
  expect(selectPluginAppEntries(catalog, { kind: "file", name: "field.note.old" })).toEqual([]);
});
