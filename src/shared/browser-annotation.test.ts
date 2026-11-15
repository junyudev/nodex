import { describe, expect, test } from "vite-plus/test";
import {
  BrowserAnnotationAttachmentSchema,
  resolveBrowserAnnotationDestination,
  BrowserAnnotationSelectionEventSchema,
  serializeBrowserAnnotationAttachmentForPrompt,
  serializeBrowserAnnotationAttachmentsForAdditionalContext,
} from "./browser-annotation";

const attachment = {
  schemaVersion: 1 as const,
  id: "annotation-1",
  browserTabId: "tab-1",
  createdAt: 1,
  intent: "designChange" as const,
  note: "Increase the spacing",
  pageTitle: "Checkout",
  pageUrl: "https://example.com/checkout",
  anchors: [
    {
      id: "anchor-1",
      kind: "region" as const,
      pageUrl: "https://example.com/checkout",
      rect: { x: 10, y: 20, width: 100, height: 50 },
    },
  ],
  evidence: {
    attachmentId: "evidence.png",
    source: "nodex://assets/evidence.png",
    mimeType: "image/png" as const,
    width: 148,
    height: 98,
  },
};

describe("Browser annotation contracts", () => {
  test("serializes design intent, anchors, and evidence without image bytes", () => {
    expect(serializeBrowserAnnotationAttachmentForPrompt(attachment)).toBe(
      [
        "[Browser design change: Checkout]",
        "URL: https://example.com/checkout",
        "1. region: rect(10, 20, 100, 50)",
        "Frame: top",
        "Comment: Increase the spacing",
        "Screenshot evidence: evidence.png",
      ].join("\n"),
    );

    const additionalContext = JSON.parse(
      serializeBrowserAnnotationAttachmentsForAdditionalContext([attachment]),
    );
    expect(additionalContext.attachments[0]).toEqual(attachment);
    expect(JSON.stringify(additionalContext)).not.toContain("base64");
  });

  test("defaults old attachments to comment intent and rejects oversized anchors", () => {
    const { intent, ...legacyAttachment } = attachment;
    expect(intent).toBe("designChange");
    expect(BrowserAnnotationAttachmentSchema.parse(legacyAttachment).intent).toBe("comment");
    expect(() =>
      BrowserAnnotationSelectionEventSchema.parse({
        sessionId: "session-1",
        multiSelect: false,
        anchor: {
          ...attachment.anchors[0],
          rect: { x: 0, y: 0, width: 100_001, height: 1 },
        },
      }),
    ).toThrow();
  });

  test("serializes structured design before and after values", () => {
    const designed = {
      ...attachment,
      designChanges: [
        {
          anchorId: "anchor-1",
          property: "borderRadius" as const,
          before: "4px",
          after: "12px",
        },
      ],
    };
    expect(serializeBrowserAnnotationAttachmentForPrompt(designed)).toContain(
      "Design property: borderRadius\nBefore: 4px\nAfter: 12px",
    );
    expect(BrowserAnnotationAttachmentSchema.parse(designed).designChanges).toEqual(
      designed.designChanges,
    );
  });
});

test("uses one stable Session destination before and after its first Thread", () => {
  expect(resolveBrowserAnnotationDestination({ sessionId: "chat" })).toBe("session:chat");
  expect(resolveBrowserAnnotationDestination({ sessionId: "chat", threadId: "thread" })).toBe(
    "session:chat",
  );
  expect(resolveBrowserAnnotationDestination({ threadId: "child" })).toBe("thread:child");
  expect(
    resolveBrowserAnnotationDestination({
      projectDraft: { projectId: "project", draftId: "draft" },
    }),
  ).toBe("project-draft:project:draft");
  expect(resolveBrowserAnnotationDestination({})).toBeNull();
});

test("the Agent receives actionable frame, selector, role, name, selected and nearby text", () => {
  const message = serializeBrowserAnnotationAttachmentForPrompt({
    ...attachment,
    anchors: [
      {
        ...attachment.anchors[0]!,
        kind: "text",
        framePath: ["#frame"],
        frameUrl: "https://example.com/frame",
        selector: "#copy",
        shadowHosts: ["#host"],
        elementPath: "#host >>> #copy",
        role: "heading",
        name: "Checkout",
        selectedText: "Pay now",
        nearbyText: "Secure checkout",
      },
    ],
  });
  for (const fact of [
    "Frame: #frame",
    "Frame URL: https://example.com/frame",
    "Target selector: #host >>> #copy",
    "Target role: heading",
    "Target name: Checkout",
    "Selected text: Pay now",
    "Nearby text: Secure checkout",
  ])
    expect(message).toContain(fact);
});
