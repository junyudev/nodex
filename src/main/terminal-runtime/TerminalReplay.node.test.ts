import { expect, test } from "vite-plus/test";
import { terminalReplayData } from "./TerminalReplay";

test.each([
  ["status reports with private and intermediate bytes", "A\x1b[6n\x1b[?25;4 nB", "AB"],
  ["numeric OSC queries with either terminator", "A\x1b]10;?\x07\x1b]0011;?\x1b\\B", "AB"],
  [
    "colors and alternate-screen transitions",
    "\x1b[31m\x1b[?1049hred\x1b[?1049l",
    "\x1b[31m\x1b[?1049hred\x1b[?1049l",
  ],
  [
    "non-query OSC payloads and extra fields",
    "\x1b]0;name\x07\x1b]4;1;?\x1b\\",
    "\x1b]0;name\x07\x1b]4;1;?\x1b\\",
  ],
  ["query-looking text inside OSC", "\x1b]0;a\x1b[6n\x07", "\x1b]0;a\x1b[6n\x07"],
  ["an incomplete CSI after a query", "\x1b[5nA\x1b[?6", "A\x1b[?6"],
  [
    "an incomplete OSC with embedded escapes",
    "\x1b[5nA\x1b]11;?\x1b[6n\x1b",
    "A\x1b]11;?\x1b[6n\x1b",
  ],
  ["a tail that begins mid-sequence", "11;?\x076n\x1bc", "11;?\x076n\x1bc"],
])("filters terminal replay with %s", (_name, input, expected) => {
  expect(terminalReplayData(input)).toBe(expected);
});
