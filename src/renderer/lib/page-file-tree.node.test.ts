import { describe, expect, it } from "vitest";
import { buildPageFileTree, type PageFileTreeFile } from "./page-file-tree";

const file = (
  fileId: string,
  logicalPath: string | null,
  sourceKey: string | null = "agent:chat",
  attachedAtMs: number | null = 1_000,
): PageFileTreeFile<null> => ({
  fileId,
  logicalPath,
  defaultName: logicalPath?.split("/").at(-1) ?? `${fileId}.png`,
  sourceKey,
  attachedAtMs,
  value: null,
});

const outline = (rows: ReturnType<typeof buildPageFileTree<null>>["rows"]) =>
  rows.map((row) => {
    const label = `${"  ".repeat(row.depth)}${row.kind === "folder" ? `${row.name}/` : row.name}`;
    const source = row.kind !== "group" && row.provenance ? ` <${row.provenance.sourceKey}>` : "";
    return `${label}${source}`;
  });

describe("buildPageFileTree", () => {
  it("states one shared origin in the summary and nowhere else", () => {
    const tree = buildPageFileTree([
      file("trace", "profile/trace.json", "agent:chat", 3_000),
      file("report", "profile/report.html", "agent:chat", 1_000),
      file("flame", "profile/flamegraph.png", "agent:chat", 2_000),
    ]);

    expect(tree.provenance).toEqual({ sourceKey: "agent:chat", latestAttachedAtMs: 3_000 });
    expect(outline(tree.rows)).toEqual([
      "profile/",
      "  flamegraph.png",
      "  report.html",
      "  trace.json",
    ]);
  });

  it("moves origins down to the narrowest folder or File they cover", () => {
    const tree = buildPageFileTree([
      file("report", "profile/report.html", "agent:chat"),
      file("trace", "profile/raw/trace.json", "agent:chat"),
      file("brief", "brief.pdf", "person"),
      file("old", "notes/old.md", "agent:other"),
      file("new", "notes/new.md", "person"),
    ]);

    expect(tree.provenance).toBeNull();
    expect(outline(tree.rows)).toEqual([
      "notes/",
      "  new.md <person>",
      "  old.md <agent:other>",
      "profile/ <agent:chat>",
      "  raw/",
      "    trace.json",
      "  report.html",
      "brief.pdf <person>",
    ]);
  });

  it("keeps body-only Files in a trailing group without inventing paths or origins", () => {
    const tree = buildPageFileTree([
      file("report", "profile/report.html"),
      file("photo", null, null, null),
    ]);

    expect(tree.provenance).toBeNull();
    expect(outline(tree.rows)).toEqual([
      "profile/ <agent:chat>",
      "  report.html",
      "In page",
      "photo.png",
    ]);
    expect(tree.rows.at(-2)).toMatchObject({ kind: "group", fileCount: 1 });
  });

  it("hides the contents of folded folders but keeps their counts", () => {
    const tree = buildPageFileTree(
      [file("a", "profile/a.json"), file("b", "profile/raw/b.json"), file("c", "c.txt", "person")],
      new Set(["profile"]),
    );

    expect(outline(tree.rows)).toEqual(["profile/ <agent:chat>", "c.txt <person>"]);
    expect(tree.rows[0]).toMatchObject({ kind: "folder", expanded: false, fileCount: 2 });
  });

  it("orders folders before Files and names naturally", () => {
    const tree = buildPageFileTree([
      file("10", "run 10.json"),
      file("2", "run 2.json"),
      file("z", "zeta/a.txt"),
      file("A", "Alpha/a.txt"),
    ]);

    expect(outline(tree.rows)).toEqual([
      "Alpha/",
      "  a.txt",
      "zeta/",
      "  a.txt",
      "run 2.json",
      "run 10.json",
    ]);
  });

  it("states an origin without a time when none was recorded", () => {
    const tree = buildPageFileTree([file("a", "a.txt", "external", null)]);

    expect(tree.provenance).toEqual({ sourceKey: "external", latestAttachedAtMs: null });
  });
});
