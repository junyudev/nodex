import { describe, expect, test } from "bun:test";

import { getAttachmentTooltipLines } from "./attachment-chip-tooltip";

describe("attachment chip tooltip", () => {
  test("shows the linked path on the first tooltip line", () => {
    const tooltip = getAttachmentTooltipLines({
      kind: "file",
      mode: "link",
      source: "/tmp/report.txt",
      bytes: 2048,
    });

    expect(tooltip.primary).toBe("/tmp/report.txt");
    expect(tooltip.secondary).toBe("Linked attachment • 2.0 KB • Click for details");
  });

  test("keeps saved attachments on a concise non-path first line", () => {
    const tooltip = getAttachmentTooltipLines({
      kind: "text",
      mode: "materialized",
      source: "nodex://assets/demo.txt",
      bytes: 12,
    });

    expect(tooltip.primary).toBe("Saved attachment");
    expect(tooltip.secondary).toBe("text • 12 B • Click for details");
  });
});
