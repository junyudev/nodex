import { expect, it } from "vite-plus/test";
import { truncateUtf8Tail } from "./AcpTerminalOwner";

it("retains a valid UTF-8 suffix within the ACP terminal byte limit", () => {
  const result = truncateUtf8Tail("prefix-你好🙂-tail", 11);

  expect(result.truncated).toBe(true);
  expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(11);
  expect(result.output).toBe("🙂-tail");
  expect(result.output).not.toContain("�");
});
