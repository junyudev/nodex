import { expect, it, vi } from "vite-plus/test";
import { prepareAgentPrompt } from "./agent-prompt";

it("preserves document ordering, pasted text, local files and skills without duplicating mentions", async () => {
  const read = vi.fn(async () => "Full temporary paste contents");
  const temporary = { label: "Paste", path: "/temp/paste.txt", fsPath: "/temp/paste.txt" };
  expect(
    await prepareAgentPrompt(
      "fallback",
      {
        text: "fallback",
        documentItems: [
          { type: "text", text: "Use " },
          { type: "skill", name: "audit", path: "/skills/audit/SKILL.md" },
        ],
        skills: [{ name: "audit", path: "/skills/audit/SKILL.md" }],
        textAttachments: [
          { text: "Complete pasted instructions" },
          { file: temporary, preview: "Truncated preview" },
        ],
        fileAttachments: [
          { label: "app.ts", path: "app.ts", fsPath: "/project/app.ts", startLine: 5, endLine: 10 },
        ],
      },
      read,
    ),
  ).toBe(
    "Use [audit](/skills/audit/SKILL.md)\n\n[app.ts](/project/app.ts):5-10\n\nComplete pasted instructions\n\nFull temporary paste contents",
  );
  expect(read).toHaveBeenCalledExactlyOnceWith(temporary);
});

it("rejects unsupported inputs and unavailable paste sources before submission", async () => {
  const read = vi.fn(async () => {
    throw new Error("Paste source unavailable");
  });
  await expect(
    prepareAgentPrompt("Inspect", { text: "Inspect", images: [{ source: "/image.png" }] }, read),
  ).rejects.toThrow("does not support image");
  await expect(
    prepareAgentPrompt("Run", { text: "Run", agentConfigs: [{ model: "other" }] }, read),
  ).rejects.toThrow("model and mode menus");
  await expect(
    prepareAgentPrompt(
      "Inspect",
      {
        text: "Inspect",
        textAttachments: [
          { file: { label: "Paste", path: "/missing", fsPath: "/missing" }, preview: "Preview" },
        ],
      },
      read,
    ),
  ).rejects.toThrow("Paste source unavailable");
});

it("dispatches the selected native skill at the start of the text block with all context as arguments", async () => {
  const result = await prepareAgentPrompt(
    "fallback",
    {
      text: "fallback",
      documentItems: [
        { type: "text", text: "First inspect " },
        { type: "skill", name: "review", path: "/skills/review" },
        { type: "text", text: " then " },
        { type: "skill", name: "audit", path: "/skills/audit" },
        { type: "text", text: " the change" },
      ],
      textAttachments: [{ text: "Full evidence" }],
      images: [{ source: "data:image/png;base64,AA==" }],
    },
    vi.fn(),
    { images: true, nativeSkills: true },
  );
  expect(result).toBe("/audit First inspect /review then  the change\n\nFull evidence");
});
