import { expect, test } from "vite-plus/test";
import { formatAppVersion } from "./app-version";

test.each([
  ["1.0.1", "0.5.5 (1)"],
  ["1.25.23", "0.5.5 (2523)"],
  ["1.99.99", "0.5.5 (9999)"],
  ["2.0.0", "0.5.5 (10000)"],
  ["9999.99.99", "0.5.5 (99989999)"],
  ["0.0.0", "0.5.5"],
  ["1.0.0", "0.5.5"],
  ["1.025.23", "0.5.5"],
  ["1.100.23", "0.5.5"],
  [undefined, "0.5.5"],
])("formats the display version with build version %s", (buildVersion, expected) => {
  expect(formatAppVersion("0.5.5", buildVersion)).toBe(expected);
});
