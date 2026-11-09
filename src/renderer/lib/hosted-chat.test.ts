import { describe, expect, test } from "vite-plus/test";
import { separateHostedChatUploads } from "./hosted-chat";

describe("a hosted chat's Composer input", () => {
  test("uploads this computer's files and names them instead of their paths", () => {
    const pageLink = "nodex://page/space/page-1";
    const { promptInput, uploads } = separateHostedChatUploads({
      text: "Compare @report.pdf with the plan",
      documentItems: [
        { type: "text", text: "Compare " },
        { type: "mention", name: "report.pdf", path: "/Users/bob/report.pdf" },
        { type: "text", text: " with " },
        { type: "mention", name: "Plan", path: pageLink },
        { type: "skill", name: "review", path: "/srv/host/skills/review/SKILL.md" },
      ],
      fileAttachments: [
        { label: "notes.md", path: "notes.md", fsPath: "/Users/bob/notes.md" },
        { label: "report.pdf", path: "/Users/bob/report.pdf", fsPath: "/Users/bob/report.pdf" },
      ],
      addedFiles: [{ label: "data.csv", path: "C:\\data\\data.csv", fsPath: "" }],
      pageReferences: [],
    });
    expect(uploads).toEqual([
      { name: "notes.md", path: "/Users/bob/notes.md" },
      { name: "report.pdf", path: "/Users/bob/report.pdf" },
      { name: "data.csv", path: "C:\\data\\data.csv" },
    ]);
    // Pages and the host's own skills stay referenced exactly as written.
    expect(promptInput).toEqual({
      text: "Compare @report.pdf with the plan",
      documentItems: [
        { type: "text", text: "Compare " },
        { type: "text", text: "report.pdf" },
        { type: "text", text: " with " },
        { type: "mention", name: "Plan", path: pageLink },
        { type: "skill", name: "review", path: "/srv/host/skills/review/SKILL.md" },
      ],
      pageReferences: [],
    });
  });

  test("leaves input that names no file here unchanged", () => {
    const input = {
      text: "Summarize",
      mentions: [{ name: "Release chat", path: "thread://thread-1" }],
    };
    expect(separateHostedChatUploads(input)).toEqual({ promptInput: input, uploads: [] });
    expect(separateHostedChatUploads(undefined)).toEqual({ promptInput: undefined, uploads: [] });
  });
});
