import { describe, expect, it } from "vite-plus/test";

import {
  compactDynamicToolOutput,
  MAX_TOOL_OUTPUT_IMAGES,
  omitToolOutputImageData,
  toolOutputImages,
  toolOutputIndicatesFailure,
} from "./toolOutput.ts";

describe("compactDynamicToolOutput", () => {
  it("extracts IDs through the MCP result envelopes used by Nodex summaries", () => {
    const metadata = { threadId: "thread-1", messageId: "message-1" };
    const json = JSON.stringify({ ...metadata, response: "Private response body" });
    for (const value of [
      { ...metadata, response: "Private response body" },
      { structuredContent: JSON.parse(json), content: "Ignored alternative body" },
      [{ type: "text", text: json }],
      { content: [{ text: { text: json } }], isError: false },
      json,
    ]) {
      expect(compactDynamicToolOutput(value)).toEqual(metadata);
    }
  });

  it("keeps nested thread identity and scalar task IDs without result bodies", () => {
    const output = {
      thread: { threadId: "thread-1", messages: ["Private message"] },
      taskId: "task-1",
      scheduledTaskId: "scheduled-1",
      status: "failed",
      summary: "A child failed; the tool itself succeeded.",
    };
    expect(compactDynamicToolOutput(output)).toEqual({
      thread: { threadId: "thread-1" },
      taskId: "task-1",
      scheduledTaskId: "scheduled-1",
    });
    expect(output.thread.messages).toEqual(["Private message"]);
  });

  it("keeps explicit envelope failure while dropping error text and arbitrary output", () => {
    for (const failure of [
      { isError: true },
      { is_error: true },
      { _tag: "OrchestratorMcpFailure" },
      { error: { message: "Private error" } },
    ]) {
      expect(
        compactDynamicToolOutput({
          ...failure,
          structuredContent: { threadId: "thread-1", error: "Private details" },
        }),
      ).toEqual({ isError: true, threadId: "thread-1" });
    }
    expect(compactDynamicToolOutput("Private plain text")).toBeUndefined();
    expect(compactDynamicToolOutput({ result: { body: "Private result" } })).toBeUndefined();
  });

  it("uses the first result data but combines explicit failure flags across content blocks", () => {
    expect(
      compactDynamicToolOutput([
        { text: JSON.stringify({ threadId: "first" }) },
        { text: JSON.stringify({ threadId: "second", isError: true, error: "Private error" }) },
      ]),
    ).toEqual({ threadId: "first", isError: true });
    expect(
      compactDynamicToolOutput([{ text: "{}" }, { text: JSON.stringify({ threadId: "second" }) }]),
    ).toBeUndefined();
  });

  it("keeps complete thread creation batches and rollback markers without row bodies", () => {
    expect(
      compactDynamicToolOutput({
        threads: [
          { threadId: "created", status: "running", messages: ["Private message"] },
          { threadId: "reverted", status: "rolled_back", error: "Private error" },
          { status: "rolled_back" },
        ],
      }),
    ).toEqual({
      threads: [
        { threadId: "created" },
        { threadId: "reverted", status: "rolled_back" },
        { status: "rolled_back" },
      ],
    });
    expect(compactDynamicToolOutput({ threadId: "reverted", status: "rolled_back" })).toEqual({
      threadId: "reverted",
      status: "rolled_back",
    });
    expect(compactDynamicToolOutput({ threads: [] })).toEqual({ threads: [] });
  });

  it("omits incomplete or oversized creation evidence instead of returning a partial count", () => {
    for (const threads of [
      [{ threadId: "known" }, { title: "No confirmed ID" }],
      Array.from({ length: 101 }, (_, index) => ({ threadId: `thread-${index}` })),
      Array.from({ length: 100 }, (_, index) => ({ threadId: `${index}`.padEnd(256, "x") })),
      [{ threadId: "x".repeat(257) }],
    ]) {
      expect(
        compactDynamicToolOutput({
          threadId: "must-not-be-counted-as-one",
          status: "rolled_back",
          taskId: "task-1",
          threads,
        }),
      ).toEqual({ taskId: "task-1" });
    }
    const normalBatch = {
      threads: Array.from({ length: 100 }, (_, index) => ({
        threadId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      })),
    };
    expect(compactDynamicToolOutput(normalBatch)).toEqual(normalBatch);
    expect(
      new TextEncoder().encode(JSON.stringify(compactDynamicToolOutput(normalBatch))).byteLength,
    ).toBeLessThanOrEqual(8_192);
  });

  it("bounds parsing and envelope scanning while preserving an outer failure marker", () => {
    const oversizedJson = JSON.stringify({ threadId: "hidden", body: "😄".repeat(5_000) });
    for (const content of [
      "x".repeat(1_000_000),
      oversizedJson,
      Array.from({ length: 33 }, () => ({ text: JSON.stringify({ threadId: "hidden" }) })),
      { content: { content: { content: { content: { threadId: "too-deep" } } } } },
    ]) {
      expect(compactDynamicToolOutput({ isError: true, content })).toEqual({ isError: true });
    }
    expect(compactDynamicToolOutput({ threadId: "known", body: "x".repeat(1_000_000) })).toEqual({
      threadId: "known",
    });
  });

  it("is idempotent for compact metadata", () => {
    const compact = compactDynamicToolOutput({
      isError: true,
      structuredContent: {
        threadId: "thread-1",
        threads: [{ threadId: "thread-1" }, { status: "rolled_back" }],
        output: "Private output",
      },
    });
    expect(compactDynamicToolOutput(compact)).toEqual(compact);
  });
});

describe("toolOutputIndicatesFailure", () => {
  it("preserves the command failure phrases across shells without copying the output", () => {
    for (const text of [
      "FILE NOT FOUND",
      "No files found",
      "ENOENT",
      "No such file or directory",
      "CommandNotFoundException",
      "command not found",
      "Cannot find path 'a' because it does not exist",
      "The term 'example' is not recognized",
      "is not recognized as the name of a cmdlet",
      "A parameter cannot be found that matches parameter name",
      "<exited with exit code 2>",
      "Exited with exit code 1",
      "exit code: 127",
    ])
      expect(toolOutputIndicatesFailure(text)).toBe(true);
  });

  it("does not mark successful exit codes or incomplete failure phrases", () => {
    for (const text of [
      "Done",
      "exit code: 0",
      "Exited with exit code 0",
      "cannot find path",
      "is not recognized",
    ]) {
      expect(toolOutputIndicatesFailure(text)).toBe(false);
    }
  });
});

describe("toolOutputImages", () => {
  const mcpImage = { type: "image", data: "AAAA", mimeType: "image/png" };
  const claudeImage = {
    type: "image",
    source: { type: "base64", media_type: "image/JPEG", data: "BBBB" },
  };
  const text = { type: "text", text: "{}" };

  it("finds images in each place providers store them, in order", () => {
    expect(toolOutputImages({ content: [text, claudeImage, mcpImage] })).toEqual([
      { mimeType: "image/jpeg", data: "BBBB" },
      { mimeType: "image/png", data: "AAAA" },
    ]);
    expect(toolOutputImages([mcpImage])).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
    expect(toolOutputImages(mcpImage)).toEqual([{ mimeType: "image/png", data: "AAAA" }]);
  });

  it("skips types the server must not serve inline", () => {
    expect(
      toolOutputImages([
        { ...mcpImage, mimeType: "image/svg+xml" },
        { ...mcpImage, mimeType: "text/html" },
        { type: "image", source: { type: "url", url: "https://example.com/a.png" } },
      ]),
    ).toEqual([]);
  });

  it("stops after the first few images", () => {
    const images = toolOutputImages(Array.from({ length: 10_000 }, () => mcpImage));
    expect(images).toHaveLength(MAX_TOOL_OUTPUT_IMAGES);
  });

  it("drops the bytes but keeps each image's position", () => {
    const omitted = omitToolOutputImageData({ content: [text, claudeImage, mcpImage] });
    expect(omitted).toEqual({
      content: [
        text,
        { type: "image", mimeType: "image/jpeg" },
        { type: "image", mimeType: "image/png" },
      ],
    });
    expect(toolOutputImages(omitted)).toEqual([
      { mimeType: "image/jpeg" },
      { mimeType: "image/png" },
    ]);
  });
});

describe("compactDynamicToolOutput content results", () => {
  const envelope = (data: unknown) => ({
    content: [{ type: "text", text: JSON.stringify({ data }) }],
  });

  it("keeps a read's name and identity without its body", () => {
    expect(
      compactDynamicToolOutput(
        envelope({
          resource: {
            id: "page-1",
            pageKey: "LAB-13",
            type: "page",
            title: { markdown: "Launch plan", etag: "etag" },
            lifecycle: "active",
          },
          content: { format: "markdown", markdown: "secret body" },
        }),
        "mcp__nodex_app__fetch",
      ),
    ).toEqual({
      data: {
        resource: {
          id: "page-1",
          pageKey: "LAB-13",
          type: "page",
          title: { markdown: "Launch plan" },
        },
      },
    });
  });

  it("counts results and rows instead of retaining them", () => {
    expect(
      compactDynamicToolOutput(
        envelope({ results: [{ kind: "page", id: "a", title: "A" }, { kind: "page", id: "b" }] }),
        "nodex_app.search",
      ),
    ).toEqual({ data: { resultCount: 2 } });
    expect(
      compactDynamicToolOutput(
        envelope({
          view: { viewId: "v", name: "Roadmap" },
          dataSource: { dataSourceId: "d", name: "Tasks", properties: [] },
          rows: [{ pageId: "a", values: {} }],
        }),
        "nodex_app.query_database_view",
      ),
    ).toEqual({
      data: { view: { name: "Roadmap" }, dataSource: { name: "Tasks" }, resultCount: 1 },
    });
  });

  it("keeps identities a row can only learn from the result", () => {
    expect(
      compactDynamicToolOutput(
        envelope({
          pages: [{ pageId: "new", pageKey: null, location: { kind: "library" }, blockIds: ["x"] }],
          created: 1,
        }),
        "mcp__nodex_app__create_pages",
      ),
    ).toEqual({ data: { pages: [{ pageId: "new" }] } });
    expect(
      compactDynamicToolOutput(
        envelope({ sourcePageId: "old", pageId: "copy", bodyBlocksCreated: 2 }),
        "mcp__nodex_app__duplicate_page",
      ),
    ).toEqual({ data: { pageId: "copy" } });
  });

  it("yields the same digest when compacted again", () => {
    const digest = compactDynamicToolOutput(
      envelope({ results: [{ id: "a" }], view: { name: "Roadmap" } }),
      "nodex_app.search",
    );

    expect(compactDynamicToolOutput(digest, "nodex_app.search")).toEqual(digest);
  });

  it("is only read for the application's own content tools", () => {
    const foreign = envelope({ pages: [{ pageId: "x" }], results: [{}] });

    expect(compactDynamicToolOutput(foreign)).toBeUndefined();
    expect(compactDynamicToolOutput(foreign, "mcp__other__fetch")).toBeUndefined();
    expect(compactDynamicToolOutput(foreign, "nodex_app.list_projects")).toBeUndefined();
  });

  it("gives up the digest before an oversized result reaches the timeline", () => {
    const title = "t".repeat(512);
    const pages = Array.from({ length: 16 }, (_, index) => ({
      pageId: `${index}`.padEnd(256, "p"),
      pageKey: `${index}`.padEnd(256, "k"),
    }));
    const output = compactDynamicToolOutput(
      { structuredContent: { data: { pages, view: { name: title } } } },
      "nodex_app.create_pages",
    );

    expect(output).toBeUndefined();
  });
});
