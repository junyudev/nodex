import { buildReviewFileSafety } from "../../../../shared/review-file-safety";
import { describe, expect, test } from "vite-plus/test";
import type { CodexConversationItem, CodexConversationTurn } from "../../../lib/types";
import {
  collectTurnEndResources,
  filterTurnOutputCandidates,
  collectTurnOutputCandidates,
  buildThreadSummaryPanelOutputRows,
  projectTurnEndOutputCandidates,
  getTurnEndResourcePaths,
} from "./thread-summary-panel-output-model";
import { readTurnArtifactReferences } from "./turn-artifact-citations";
import { buildCodexFileChangeMap } from "../../../../shared/codex-file-change";

function message(id: string, text: string): CodexConversationItem {
  return {
    threadId: "thread",
    turnId: "turn",
    itemId: id,
    entryId: id,
    type: "agentMessage",
    kind: "assistantMessage",
    semanticKind: "assistantMessage",
    markdownText: text,
    createdAt: 1,
    updatedAt: 1,
    status: "completed",
  };
}
function turn(
  items: CodexConversationItem[],
  status: CodexConversationTurn["status"] = "completed",
): CodexConversationTurn {
  return {
    threadId: "thread",
    turnId: "turn",
    status,
    items,
    itemIds: items.map((item) => item.itemId),
  };
}
const scope = { cwd: "/workspace" };

describe("completed turn resource discovery", () => {
  test("parses real output directives while excluding protected Markdown and escapes", () => {
    const source = [
      ':codex-file-citation{path="result.pdf"}',
      ':codex-file-citation{purpose="source" path="source.pdf"}',
      '` :codex-file-citation{path="inline.pdf"} `',
      '```md\n:codex-file-citation{path="fenced.pdf"}\n```',
      '<div>\n:codex-file-citation{path="html.pdf"}\n</div>',
      '\\:codex-file-citation{path="escaped.pdf"}',
      '[link](:codex-file-citation{path="destination.pdf"})',
      '![image :codex-file-citation{path="alt.pdf"}](example.png)',
      ':codex-file-citation{path="invalid.pdf" page_id="not-a-uuid"}',
    ].join("\n\n");
    expect(readTurnArtifactReferences(source).citations.map(({ path }) => path)).toEqual([
      "result.pdf",
      "source.pdf",
    ]);
    expect(
      getTurnEndResourcePaths(collectTurnEndResources(turn([message("one", source)]), scope)),
    ).toEqual(["/workspace/result.pdf"]);
  });

  test("separates output extension rules from final assistant link fallback", () => {
    const resources = collectTurnEndResources(
      turn([
        message(
          "commentary",
          '[earlier](commentary.pdf)\n:codex-file-citation{path="artifact.csv"}',
        ),
        message(
          "final",
          '[PDF](final.pdf) [image](linked.png) [notes](notes.md) [TeX](formula.tex)\n:codex-file-citation{path="output.png"}',
        ),
      ]),
      scope,
    );
    expect(getTurnEndResourcePaths(resources)).toEqual([
      "/workspace/artifact.csv",
      "/workspace/output.png",
      "/workspace/final.pdf",
      "/workspace/formula.tex",
    ]);
    expect(
      collectTurnEndResources(turn([message("active", "[PDF](live.pdf)")], "inProgress"), scope),
    ).toEqual([]);
  });

  test("source citations and legacy references prevent output fallback", () => {
    const resources = collectTurnEndResources(
      turn([
        message(
          "one",
          [
            ':codex-file-citation{path="read.pdf" purpose="source"}',
            "[read](read.pdf)",
            "【F:legacy.pdf†L1】 [legacy](legacy.pdf)",
            "[new](new.pdf)",
          ].join("\n"),
        ),
      ]),
      scope,
    );
    expect(getTurnEndResourcePaths(resources)).toEqual(["/workspace/new.pdf"]);
  });

  test("excludes scratch, outside-projectless and visualization paths with stable path deduplication", () => {
    const resources = collectTurnEndResources(
      turn([
        message(
          "one",
          [
            ':codex-file-citation{path="output/./result.pdf"}',
            ':codex-file-citation{path="OUTPUT/result.pdf"}',
            ':codex-file-citation{path="work/draft.pdf"}',
            ':codex-file-citation{path=".codex_scratch/draft.pdf"}',
            ':codex-file-citation{path="elsewhere.pdf"}',
            ':codex-file-citation{path="output/widget.pdf"}',
            '::codex-inline-vis{file="output/widget.pdf"}',
            "[widget](/workspace/output/widget.pdf)",
          ].join("\n\n"),
        ),
      ]),
      { ...scope, projectlessOutputDirectory: "/workspace/output" },
    );
    expect(getTurnEndResourcePaths(resources)).toEqual(["/workspace/output/result.pdf"]);
  });

  test("requires confirmed non-source paths for edited HTML and document deliverables", () => {
    const patch: CodexConversationItem = {
      ...message("patch", ""),
      type: "fileChange",
      kind: "fileChange",
      semanticKind: "patch",
      fileChange: {
        label: "site.html",
        changes: buildCodexFileChangeMap([
          {
            type: "update",
            path: "site.html",
            movePath: null,
            unifiedDiff: "@@ -1 +1 @@\n-old\n+new",
          },
          {
            type: "update",
            path: "edited.pdf",
            movePath: null,
            unifiedDiff: "@@ -1 +1 @@\n-old\n+new",
          },
        ]),
      },
    };
    const pathStates = new Map(
      ["site.html", "edited.pdf"].map((relative) => {
        const path = `/workspace/${relative}`;
        return [path, { path, exists: true, isGitSourcePath: false }];
      }),
    );
    expect(collectTurnEndResources(turn([patch]), scope)).toEqual([]);
    expect(
      collectTurnEndResources(turn([patch]), { ...scope, pathStates }).map(({ kind }) => kind),
    ).toEqual(["file", "file"]);
    expect(
      getTurnEndResourcePaths(collectTurnEndResources(turn([patch]), { ...scope, pathStates })),
    ).toEqual(["/workspace/site.html", "/workspace/edited.pdf"]);
    expect(collectTurnEndResources(turn([{ ...patch, status: "inProgress" }]), scope)).toEqual([]);
  });

  test("filters files by shared path state and retains explicit outputs after query failure", () => {
    const candidates = collectTurnOutputCandidates(
      turn([
        message(
          "one",
          "[file](result.pdf) [doc](https://docs.google.com/document/d/drive-id/edit)",
        ),
      ]),
      scope,
    );
    expect(
      filterTurnOutputCandidates(candidates, new Map(), scope.cwd).map(({ kind }) => kind),
    ).toEqual(["google-drive"]);
    expect(
      getTurnEndResourcePaths(
        filterTurnOutputCandidates(
          candidates,
          new Map([
            [
              "/workspace/RESULT.pdf",
              { path: "/workspace/RESULT.pdf", exists: true, isGitSourcePath: true },
            ],
          ]),
          scope.cwd,
        ),
      ),
    ).toEqual(["/workspace/result.pdf"]);
    expect(filterTurnOutputCandidates(candidates, undefined, scope.cwd)).toEqual(
      candidates.map(({ resource }) => resource),
    );
  });

  test("does not invent a website after path filtering removes a file candidate", () => {
    const candidates = collectTurnOutputCandidates(
      turn([message("one", "[file](missing.pdf) http://localhost:3000")]),
      scope,
    );
    expect(candidates.map(({ resource }) => resource.kind)).toEqual(["file"]);
    expect(filterTurnOutputCandidates(candidates, new Map(), scope.cwd)).toEqual([]);
  });

  test("Drive read-only calls suppress link fallback while writes and explicit outputs retain their actual identity", () => {
    const url = "https://docs.google.com/document/d/e/published-id/edit";
    const driveTool = (tool: string): CodexConversationItem => ({
      ...message("drive", ""),
      kind: "toolCall",
      semanticKind: "toolCall",
      type: "mcpToolCall",
      mcpToolCall: {
        callId: "drive",
        functionName: tool,
        pluginId: "google-drive",
        readOnlyHint: true,
        mcpAppResourceUri: undefined,
        source: null,
        invocation: { server: "connector", tool, arguments: {} },
        result: {
          type: "success",
          content: [],
          structuredContent: { web_view_link: url, display_title: "Created draft" },
          raw: {
            content: [],
            structuredContent: { web_view_link: url, display_title: "Created draft" },
            _meta: null,
          },
        },
        durationMs: null,
        completed: true,
      },
    });
    const linked = message("answer", `[Draft](${url})`);
    expect(collectTurnEndResources(turn([driveTool("get_document"), linked]), scope)).toEqual([]);
    expect(collectTurnEndResources(turn([driveTool("delete_file"), linked]), scope)).toEqual([]);
    const written = collectTurnEndResources(
      turn([driveTool("batch_update_document"), linked]),
      scope,
    );
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      kind: "google-drive",
      label: "Created draft",
      url,
      resourceKind: "document",
    });
    const explicit = message("explicit", `:codex-file-citation{path="${url}" purpose="output"}`);
    expect(
      collectTurnEndResources(turn([driveTool("get_document"), explicit]), scope),
    ).toHaveLength(1);
    const source = message(
      "source",
      `:codex-file-citation{path="source.pdf" purpose="source"} [Draft](${url})`,
    );
    expect(collectTurnEndResources(turn([driveTool("unknown_operation"), source]), scope)).toEqual(
      [],
    );
  });
});

function edit(paths: string[]): CodexConversationItem {
  return {
    ...message("patch", ""),
    type: "fileChange",
    kind: "fileChange",
    semanticKind: "patch",
    fileChange: {
      label: "outputs",
      changes: buildCodexFileChangeMap(
        paths.map((path) => ({ type: "add" as const, path, content: "deliverable" })),
      ),
    },
  };
}

describe("deliverables and source changes", () => {
  test.each([
    ["src/index.html", true, false],
    ["notes.local/artifacts/report/index.html", false, true],
    ["/elsewhere/report.pdf", false, true],
    ["docs/x.md", true, false],
    ["unknown.pdf", null, false],
  ] as const)("classifies %s from its Git visibility", (relative, isGitSourcePath, output) => {
    const path = relative.startsWith("/") ? relative : `/workspace/${relative}`;
    const pathStates = new Map([[path, { path, exists: true, isGitSourcePath }]]);
    const completed = turn([edit([relative])]);
    const options = { ...scope, pathStates };
    expect(getTurnEndResourcePaths(collectTurnEndResources(completed, options))).toEqual(
      output ? [path] : [],
    );
    expect(buildThreadSummaryPanelOutputRows([completed], options)).toEqual(
      collectTurnEndResources(completed, options),
    );
  });

  test("projectless output-directory ownership wins even inside a Git repository", () => {
    const paths = ["/workspace/output/report.md", "/workspace/elsewhere/report.pdf"];
    const pathStates = new Map(
      paths.map((path) => [path, { path, exists: true, isGitSourcePath: true }]),
    );
    expect(
      getTurnEndResourcePaths(
        collectTurnEndResources(turn([edit(paths)]), {
          ...scope,
          projectlessOutputDirectory: "/workspace/output",
          pathStates,
        }),
      ),
    ).toEqual([paths[0]]);
  });

  test("explicit output citations and supported links win over tracked Git state", () => {
    const paths = ["/workspace/src/index.html", "/workspace/docs/guide.pdf"];
    const pathStates = new Map(
      paths.map((path) => [path, { path, exists: true, isGitSourcePath: true }]),
    );
    const completed = turn([
      edit(paths),
      message(
        "final",
        ':codex-file-citation{path="src/index.html" purpose="output"} [guide](docs/guide.pdf)',
      ),
    ]);
    expect(
      getTurnEndResourcePaths(collectTurnEndResources(completed, { ...scope, pathStates })),
    ).toEqual(paths);
  });

  test("failed queries retain explicit outputs without promoting edited Project paths", () => {
    const candidates = collectTurnOutputCandidates(
      turn([edit(["report.pdf"]), message("final", "[guide](guide.pdf)")]),
      scope,
    );
    expect(
      getTurnEndResourcePaths(filterTurnOutputCandidates(candidates, undefined, scope.cwd)),
    ).toEqual(["/workspace/guide.pdf"]);
    expect(
      getTurnEndResourcePaths(
        filterTurnOutputCandidates(
          candidates,
          new Map([
            ["/workspace/report.pdf", null],
            ["/workspace/guide.pdf", null],
          ]),
          scope.cwd,
        ),
      ),
    ).toEqual(["/workspace/guide.pdf"]);
  });

  test("summary unions turns newest first, moves re-edited normalized paths, and caps after filtering", () => {
    const older = turn([edit(["old.pdf", "report.pdf", "oldest.pdf"])]);
    const newer = turn([
      edit(["./report.pdf", "new.pdf", "missing.pdf", "four.pdf", "five.pdf", "six.pdf"]),
    ]);
    const paths = [
      "old.pdf",
      "report.pdf",
      "oldest.pdf",
      "new.pdf",
      "four.pdf",
      "five.pdf",
      "six.pdf",
    ].map((path) => `/workspace/${path}`);
    const pathStates = new Map(
      paths.map((path) => [path, { path, exists: true, isGitSourcePath: false }]),
    );
    pathStates.set("/workspace/missing.pdf", {
      path: "/workspace/missing.pdf",
      exists: false,
      isGitSourcePath: false,
    });
    expect(
      getTurnEndResourcePaths(
        buildThreadSummaryPanelOutputRows([older, newer], { ...scope, pathStates }),
      ),
    ).toEqual([
      "/workspace/report.pdf",
      "/workspace/new.pdf",
      "/workspace/four.pdf",
      "/workspace/five.pdf",
      "/workspace/six.pdf",
    ]);
    expect(
      getTurnEndResourcePaths(
        buildThreadSummaryPanelOutputRows([older, turn([edit(["./report.pdf", "new.pdf"])])], {
          ...scope,
          pathStates,
        }),
      ),
    ).toEqual([
      "/workspace/report.pdf",
      "/workspace/new.pdf",
      "/workspace/old.pdf",
      "/workspace/oldest.pdf",
    ]);
  });

  test("summary numbers generated images once across turns, counting down from the newest turn", () => {
    const generated = (path: string): CodexConversationItem => ({
      ...message(path, ""),
      type: "imageGeneration",
      rawItem: { type: "imageGeneration", savedPath: path },
    });
    const paths = ["/workspace/a.png", "/workspace/b.png", "/workspace/c.png"];
    const pathStates = new Map(
      paths.map((path) => [path, { path, exists: true, isGitSourcePath: false }]),
    );
    expect(
      buildThreadSummaryPanelOutputRows(
        [turn([generated(paths[0]!)]), turn([generated(paths[1]!), generated(paths[2]!)])],
        { ...scope, pathStates },
      ).map((row) => [row.label, "path" in row ? row.path : null]),
    ).toEqual([
      ["Generated image 3", "/workspace/b.png"],
      ["Generated image 2", "/workspace/c.png"],
      ["Generated image 1", "/workspace/a.png"],
    ]);
  });

  test("withheld file diffs retain deletion and move semantics", () => {
    const patch: CodexConversationItem = {
      ...edit([]),
      fileChange: {
        label: "files",
        changes: buildCodexFileChangeMap([
          {
            type: "nonRenderable",
            originalType: "delete",
            path: "deleted.pdf",
            movePath: null,
            safety: buildReviewFileSafety({ binary: true }),
          },
          {
            type: "nonRenderable",
            originalType: "update",
            path: "draft.pdf",
            movePath: "final.pdf",
            safety: buildReviewFileSafety({ binary: true }),
          },
        ]),
      },
    };
    const pathStates = new Map(
      ["deleted.pdf", "draft.pdf", "final.pdf"].map((name) => {
        const path = `/workspace/${name}`;
        return [path, { path, exists: true, isGitSourcePath: false }];
      }),
    );
    expect(
      getTurnEndResourcePaths(collectTurnEndResources(turn([patch]), { ...scope, pathStates })),
    ).toEqual(["/workspace/final.pdf"]);
  });

  test.each([true, false, null])(
    "a local preview yields only to confirmed edited deliverables (Git source: %s)",
    (isGitSourcePath) => {
      const completed = turn([
        edit(["src/index.html"]),
        message("final", "Preview: http://localhost:5173"),
      ]);
      const path = "/workspace/src/index.html";
      const options = {
        ...scope,
        pathStates: new Map([[path, { path, exists: true, isGitSourcePath }]]),
      };
      const resources = collectTurnEndResources(completed, options);
      expect(resources.map(({ kind }) => kind)).toEqual(
        isGitSourcePath === false ? ["file"] : ["website"],
      );
      expect(buildThreadSummaryPanelOutputRows([completed], options)).toEqual(resources);
    },
  );

  test("a later source edit does not discard an earlier explicit deliverable", () => {
    const older = turn([message("output", "[report](tracked.pdf)")]);
    const newer = turn([edit(["tracked.pdf", "new.pdf"])]);
    const pathStates = new Map([
      [
        "/workspace/tracked.pdf",
        { path: "/workspace/tracked.pdf", exists: true, isGitSourcePath: true },
      ],
      ["/workspace/new.pdf", { path: "/workspace/new.pdf", exists: true, isGitSourcePath: false }],
    ]);
    expect(
      getTurnEndResourcePaths(
        buildThreadSummaryPanelOutputRows([older, newer], { ...scope, pathStates }),
      ),
    ).toEqual(["/workspace/new.pdf", "/workspace/tracked.pdf"]);
  });

  test("turn end projects inline protocol images out while authored image files remain", () => {
    const completed = turn([
      edit(["authored.png"]),
      {
        ...message("generated", ""),
        type: "imageGeneration",
        rawItem: { type: "imageGeneration", savedPath: "/workspace/generated.png" },
      },
      {
        ...message("view", ""),
        type: "imageView",
        rawItem: { type: "imageView", path: "/workspace/viewed.png" },
      },
    ]);
    const candidates = collectTurnOutputCandidates(completed, scope);
    expect(candidates.map(({ resource }) => resource.kind)).toEqual([
      "file",
      "generated-image",
      "image",
    ]);
    expect(projectTurnEndOutputCandidates(candidates).map(({ resource }) => resource.kind)).toEqual(
      ["file"],
    );
    const pathStates = new Map(
      ["authored.png", "generated.png", "viewed.png"].map((name) => {
        const path = `/workspace/${name}`;
        return [path, { path, exists: true, isGitSourcePath: false }];
      }),
    );
    expect(
      collectTurnEndResources(completed, { ...scope, pathStates }).map(({ kind }) => kind),
    ).toEqual(["file"]);
    expect(
      buildThreadSummaryPanelOutputRows([completed], { ...scope, pathStates }).map(
        ({ kind }) => kind,
      ),
    ).toEqual(["file", "generated-image", "image"]);
  });
});
