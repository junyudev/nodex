import { describe, expect, it } from "vite-plus/test";
import { workReportLine } from "./work-report";

describe("workReportLine", () => {
  it("previews a report by its first meaningful line, as plain text", () => {
    expect(
      workReportLine("## Done\n\nFixed the **install** typo in [README](https://x.test)"),
    ).toBe("Done");
    expect(workReportLine("\n---\n- Opened PR #42 with `vp run test` passing")).toBe(
      "Opened PR #42 with vp run test passing",
    );
    expect(workReportLine("   ")).toBe("");
  });
});
