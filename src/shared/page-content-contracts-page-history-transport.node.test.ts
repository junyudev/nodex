import { describe, expect, test, it, vi } from "vite-plus/test";
import { MAX_PAGE_HISTORY_PAGE_SIZE, type PageHistoryPage } from "./page-history";
import {
  PageHistoryContractError,
  parsePageHistoryCommandResult,
  parseListPageHistoryRequest,
} from "./page-history-transport";
import {
  buildCurrentPageKeySearchAliases,
  isPlausiblePageKeyPrefixDraft,
  isExplicitPageKeySearch,
  normalizePageKeyPrefixInput,
} from "./page-key";
import { prepareAgentMessage, retainAgentAppContext } from "./agent-prompt";
import { prepareCodexPrompt } from "./codex-prompt-preparation";
import {
  PAGE_REFERENCE_CONTEXT_KIND,
  PAGE_REFERENCES_ADDITIONAL_CONTEXT_KEY,
  pageReferencePayload,
  readRuntimePageReferences,
  readPageReferencesAdditionalContext,
  serializePageReferences,
  withoutPageReferenceInput,
  type PageReference,
} from "./page-reference";
import { projectMessageForProvider } from "../../packages/agent-runtime/vendor/shared/src/messageContextProjection";
import { pageInputToSummaryPatch, toDatabasePageSummary } from "./page-summary";
import {
  PAGE_TEXT_REWRITE_LIMITS,
  PageTextRewriteInputSchema,
  PageTextRewriteStartSchema,
} from "./page-text-rewrite";
import { parsePageTurn, type PageTurn } from "./page-turn";

describe("page history transport", () => {
  const occurredAt = "2026-07-12T08:00:00.000Z";
  const versionId = "version:history:1";

  const page: PageHistoryPage = {
    libraryId: "library:history",
    pageId: "card:history",
    documentId: "document:history",
    entries: [
      {
        id: `document-version:${versionId}`,
        kind: "document_version",
        libraryId: "library:history",
        pageId: "card:history",
        documentId: "document:history",
        occurredAt,
        display: {
          category: "checkpoint",
          title: "Saved Page checkpoint",
          detail: "Before refactor",
          actorLabel: "Agent",
        },
        evidence: { status: "verified" },
        recovery: {
          kind: "restore_document_version",
          documentId: "document:history",
          versionId,
        },
        versionMetadata: {
          versionId,
          generation: 1,
          baseHeadSeq: 4,
          schemaKey: "nodex.page@1",
          schemaVersion: 1,
          cause: "manual",
          label: "Before refactor",
          revisionKind: "manual",
          sourceMutationId: null,
          sourceChangeSeq: null,
          pinned: true,
          checkpointHash: "a".repeat(64),
          byteLength: 42,
        },
      },
    ],
    nextCursor: {
      occurredAt,
      source: "document_version",
      versionId,
    },
  };

  const rejectsContract = (operation: () => unknown): boolean => {
    try {
      operation();
      return false;
    } catch (error) {
      return error instanceof PageHistoryContractError;
    }
  };

  describe("Page history transport contract", () => {
    test("parses one exact scoped request and source-specific cursor", () => {
      const request = parseListPageHistoryRequest({
        requestingProjectId: "project:history",
        pageId: "card:history",
        pageSize: MAX_PAGE_HISTORY_PAGE_SIZE,
        before: page.nextCursor,
      });
      expect(request.pageSize).toBe(MAX_PAGE_HISTORY_PAGE_SIZE);
      expect(request.before?.source).toBe("document_version");
      expect(
        rejectsContract(() =>
          parseListPageHistoryRequest({
            ...request,
            unsupported: true,
          }),
        ),
      ).toBe(true);
      expect(
        rejectsContract(() =>
          parseListPageHistoryRequest({
            ...request,
            pageSize: MAX_PAGE_HISTORY_PAGE_SIZE + 1,
          }),
        ),
      ).toBe(true);
      expect(
        rejectsContract(() =>
          parseListPageHistoryRequest({
            ...request,
            before: {
              occurredAt,
              source: "change_log",
              versionId,
            },
          }),
        ),
      ).toBe(true);
    });

    test("validates the complete page union, scope, and continuation cursor", () => {
      const result = parsePageHistoryCommandResult({ ok: true, value: page });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.entries[0]?.kind).toBe("document_version");
      expect(result.value.nextCursor?.source).toBe("document_version");

      expect(
        rejectsContract(() =>
          parsePageHistoryCommandResult({
            ok: true,
            value: {
              ...page,
              entries: [
                {
                  ...page.entries[0],
                  libraryId: "library:foreign",
                },
              ],
            },
          }),
        ),
      ).toBe(true);
      expect(
        rejectsContract(() =>
          parsePageHistoryCommandResult({
            ok: true,
            value: {
              ...page,
              nextCursor: {
                occurredAt,
                source: "change_log",
                changeSeq: 7,
              },
            },
          }),
        ),
      ).toBe(true);
      expect(
        rejectsContract(() =>
          parsePageHistoryCommandResult({
            ok: true,
            value: {
              ...page,
              entries: [{ ...page.entries[0], rawUpdate: "secret" }],
            },
          }),
        ),
      ).toBe(true);
    });

    test("accepts only the stable typed error envelope", () => {
      const result = parsePageHistoryCommandResult({
        ok: false,
        error: {
          code: "page_not_found",
          message: "Page does not exist",
          retryable: false,
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("page_not_found");
      expect(
        rejectsContract(() =>
          parsePageHistoryCommandResult({
            ok: false,
            error: {
              code: "sql_error",
              message: "SELECT * FROM private_table",
              retryable: false,
            },
          }),
        ),
      ).toBe(true);
    });
  });
});

describe("Page key prefix", () => {
  it("normalizes drafts and gives immediate non-authoritative feedback", () => {
    expect(normalizePageKeyPrefixInput(" lab ")).toBe("LAB");
    expect(isPlausiblePageKeyPrefixDraft("LAB")).toBe(true);
    expect(isPlausiblePageKeyPrefixDraft("1LAB")).toBe(false);
  });

  it("builds canonical and compact aliases without accepting malformed keys", () => {
    expect(buildCurrentPageKeySearchAliases("LAB-13")).toEqual(["LAB-13", "LAB13"]);
    expect(buildCurrentPageKeySearchAliases("LAB-01")).toEqual([]);
    expect(isExplicitPageKeySearch(" #lab-13 ")).toBe(true);
    expect(isExplicitPageKeySearch("lab-13")).toBe(false);
  });
});

describe("page reference", () => {
  const references: readonly PageReference[] = [
    { pageId: "page-a", titleSnapshot: "Plan [v2]", selectedBlockIds: ["block-1", "block-2"] },
  ];

  test("Runtime retains only Page identity, title and highlighted Block identities as provider-readable data", async () => {
    const prepared = await prepareAgentMessage(
      "Review",
      { text: "Review", pageReferences: references },
      vi.fn(),
    );
    expect(prepared.context?.records).toEqual([
      {
        kind: PAGE_REFERENCE_CONTEXT_KIND,
        label: "Plan [v2]",
        payload: {
          pageId: "page-a",
          title: "Plan [v2]",
          url: "nodex://pages/page-a",
          selectedBlockIds: ["block-1", "block-2"],
        },
      },
    ]);
    expect(readRuntimePageReferences(prepared.context)).toEqual(references);
    expect(prepared.text).toBe("Review");
    const projected = projectMessageForProvider(prepared);
    expect(projected).toContain(JSON.stringify(pageReferencePayload(references[0]!)));
    expect(projected.startsWith("Review\n\n<nodex_context>")).toBe(true);
    expect(
      readRuntimePageReferences(retainAgentAppContext({ text: "Revise" }, prepared).context),
    ).toEqual(references);
  });

  test("Codex uses an ordinary companion text input and typed display sidecar, including reference-only sends", async () => {
    const prepared = await prepareCodexPrompt(
      "",
      { text: "", pageReferences: references },
      { resolveImageInput: vi.fn() },
    );
    expect(prepared.inputItems).toEqual([
      { type: "text", text: serializePageReferences(references), text_elements: [] },
    ]);
    expect(prepared.pendingInputItems).toEqual(prepared.inputItems);
    expect(prepared.additionalContext).toEqual({
      [PAGE_REFERENCES_ADDITIONAL_CONTEXT_KEY]: {
        kind: "application",
        value: JSON.stringify(references),
      },
    });
    const restored = readPageReferencesAdditionalContext(prepared.additionalContext);
    expect(restored).toEqual(references);
    expect(withoutPageReferenceInput(prepared.inputItems, restored)).toEqual([]);
    expect(withoutPageReferenceInput(prepared.inputItems, [])).toEqual(prepared.inputItems);
    expect(
      withoutPageReferenceInput(
        [{ type: "text", text: "# Page references:\nMy own example" }],
        restored,
      ),
    ).toEqual([{ type: "text", text: "# Page references:\nMy own example" }]);
  });

  test("malformed stored references do not become transcript context", () => {
    expect(
      readPageReferencesAdditionalContext({
        [PAGE_REFERENCES_ADDITIONAL_CONTEXT_KEY]: { value: "{" },
      }),
    ).toEqual([]);
    expect(
      readRuntimePageReferences({
        records: [{ kind: PAGE_REFERENCE_CONTEXT_KIND, payload: { pageId: "bad", title: "Bad" } }],
      }),
    ).toEqual([]);
  });
});

describe("Card summary rich-title projection", () => {
  test("preserves canonical rich title content while deriving body summary fields", () => {
    const richTitle = [
      { type: "text" as const, text: "Rich ", styles: {} },
      { type: "text" as const, text: "title", styles: { bold: true as const } },
    ];

    expect(
      toDatabasePageSummary({
        id: "card-1",
        pageKey: "LAB-13",
        status: "triage",
        archived: false,
        title: "Rich title",
        richTitle,
        description: "Body",
        tags: [],
        created: new Date("2026-01-01T00:00:00.000Z"),
        order: 0,
      }),
    ).toMatchObject({
      pageKey: "LAB-13",
      title: "Rich title",
      richTitle,
      descriptionPreview: "Body",
      descriptionLength: 4,
      hasDescription: true,
    });
  });

  test("turns an explicit plain-title mutation into one coherent rich-title projection", () => {
    expect(pageInputToSummaryPatch({ title: "Renamed" })).toEqual({
      title: "Renamed",
      richTitle: [{ type: "text", text: "Renamed", styles: {} }],
    });
  });
});

describe("page text rewrite", () => {
  const input = { markdown: "**Selected** text", instruction: "Translate to English" };

  it("accepts only bounded selection snapshots and rejects document authority or model overrides", () => {
    expect(PageTextRewriteInputSchema.parse(input)).toEqual(input);
    const cap = PAGE_TEXT_REWRITE_LIMITS;
    expect(
      PageTextRewriteInputSchema.safeParse({
        ...input,
        markdown: "a".repeat(cap.markdown),
        instruction: "a".repeat(cap.instruction),
        context: {
          before: "a".repeat(cap.surroundingText),
          after: "a".repeat(cap.surroundingText),
          pageTitle: "a".repeat(cap.pageTitle),
        },
      }).success,
    ).toBe(true);
    for (const invalid of [
      null,
      {},
      { ...input, markdown: " " },
      { ...input, instruction: "\n" },
      { ...input, markdown: "a".repeat(cap.markdown + 1) },
      { ...input, markdown: "界".repeat(Math.ceil(cap.markdown / 3)) },
      { ...input, context: { before: "a".repeat(cap.surroundingText + 1) } },
      { ...input, context: { after: 1 } },
      { ...input, context: { pageId: "page" } },
      { ...input, documentId: "document" },
      { ...input, model: "arbitrary" },
    ])
      expect(PageTextRewriteInputSchema.safeParse(invalid).success).toBe(false);
    expect(PageTextRewriteStartSchema.safeParse({ input, requestId: "not-an-id" }).success).toBe(
      false,
    );
  });
});

describe("page turn", () => {
  test("preserves the selected pause authority through the shared Turn boundary", () => {
    const turn: PageTurn = {
      page_id: "page",
      actor: { kind: "member", member_id: "member" },
      reason: "paused",
      since: "today",
      episode: "episode",
      hold: {
        scope: { kind: "project", project_id: "project" },
        actor: "member",
        revision: 4,
        paused_at: "today",
      },
    };
    expect(parsePageTurn(turn)).toEqual(turn);
    expect(() =>
      parsePageTurn({ ...turn, hold: { ...turn.hold, scope: { kind: "project" } } }),
    ).toThrow();
  });

  test("reads an attention Turn addressed to any Member", () => {
    const turn: PageTurn = {
      page_id: "page",
      actor: { kind: "members" },
      reason: "approval",
      since: "2026-11-02T09:00:00.000Z",
      episode: "episode",
      hold: null,
    };
    expect(parsePageTurn(turn)).toEqual(turn);
  });
});
