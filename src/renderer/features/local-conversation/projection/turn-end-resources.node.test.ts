import { describe, expect, test } from "vite-plus/test";
import type { CodexConversationItem, CodexConversationTurn } from "../../../lib/types";
import {
  collectTurnEndResources,
  filterTurnEndResources,
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
          ].join("\n\n"),
        ),
      ]),
      { ...scope, projectlessOutputDirectory: "/workspace/output" },
    );
    expect(getTurnEndResourcePaths(resources)).toEqual(["/workspace/output/result.pdf"]);
  });

  test("uses completed edited HTML only as a website fallback", () => {
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
    expect(collectTurnEndResources(turn([patch]), scope).map(({ kind }) => kind)).toEqual([
      "website",
    ]);
    expect(getTurnEndResourcePaths(collectTurnEndResources(turn([patch]), scope))).toEqual([
      "/workspace/site.html",
    ]);
    expect(collectTurnEndResources(turn([{ ...patch, status: "inProgress" }]), scope)).toEqual([]);
  });

  test("filters only files and preserves candidates when the query fails", () => {
    const resources = collectTurnEndResources(
      turn([
        message(
          "one",
          "[file](result.pdf) [doc](https://docs.google.com/document/d/drive-id/edit)",
        ),
      ]),
      scope,
    );
    expect(filterTurnEndResources(resources, new Set(), scope.cwd).map(({ kind }) => kind)).toEqual(
      ["google-drive"],
    );
    expect(
      getTurnEndResourcePaths(
        filterTurnEndResources(resources, new Set(["/workspace/RESULT.pdf"]), scope.cwd),
      ),
    ).toEqual(["/workspace/result.pdf"]);
    expect(filterTurnEndResources(resources, undefined, scope.cwd)).toBe(resources);
  });

  test("does not invent a website after existence filtering removes the file candidate", () => {
    const resources = collectTurnEndResources(
      turn([message("one", "[file](missing.pdf) http://localhost:3000")]),
      scope,
    );
    expect(resources.map(({ kind }) => kind)).toEqual(["file"]);
    expect(filterTurnEndResources(resources, new Set(), scope.cwd)).toEqual([]);
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
