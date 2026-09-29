import { expect, test } from "vite-plus/test";
import { AGENT_TOOL_OUTPUT_MAX_BYTES, boundAgentToolOutput } from "./agent-tool-output";

test("lazy tool output preserves complete UTF-8 text and reports its independent byte budget", () => {
  const text = "Workspace\n".repeat(8_000);
  expect(boundAgentToolOutput(text)).toEqual({
    text,
    truncated: false,
    originalBytes: new TextEncoder().encode(text).length,
  });
  const oversized = `${"a".repeat(AGENT_TOOL_OUTPUT_MAX_BYTES - 1)}🧪tail`;
  const clipped = boundAgentToolOutput(oversized);
  expect(clipped).toMatchObject({
    truncated: true,
    originalBytes: AGENT_TOOL_OUTPUT_MAX_BYTES + 7,
  });
  expect(clipped.text.endsWith("a")).toBe(true);
  expect(clipped.text).not.toContain("�");
  expect(new TextEncoder().encode(clipped.text).length).toBeLessThanOrEqual(
    AGENT_TOOL_OUTPUT_MAX_BYTES,
  );
});
