import { describe, expect, test } from "vite-plus/test";

import { productIdentityViolations } from "./verify-product-identity";

const lines = (content: string, path = "src/example.ts") =>
  productIdentityViolations(path, content).map((violation) => violation.line);

describe("product identity", () => {
  test.each([
    "the T3 server restarted",
    "T3's credential store",
    "open it in T3 Code",
    "<t3_context>",
    "t3-context://v1/image/id",
    'import { x } from "@t3tools/shared";',
    'const tag = "t3/project/Loader";',
    "const hasT3Mcp = true;",
    "const t3Rules = {};",
    "process.env.T3_ACP_LOG",
    "process.env.T3CODE_HOME",
    "https://t3.codes",
    "git clone https://github.com/example/t3code",
  ])("flags %s", (content) => {
    expect(lines(content)).toEqual([1]);
  });

  test.each([
    "Team ID 8HGUT3HC4Z",
    'fill: "url(#paint3_linear_4603)"',
    'Digit3: "3"',
    "xz -9 -T3 --memlimit-compress=4GiB",
    "a t32 grid",
  ])("leaves %s alone", (content) => {
    expect(lines(content)).toEqual([]);
  });

  test("reports each occurrence on its own line", () => {
    expect(lines("fine\nT3 Code\nfine\nt3_context")).toEqual([2, 4]);
  });

  test("permits license notices, recorded transcripts and generated lockfiles", () => {
    expect(lines('["LICENSE.t3code", "UPSTREAM.json"]')).toEqual([]);
    expect(lines("T3 Code", "packages/agent-runtime/LICENSE.t3code")).toEqual([]);
    expect(lines("Copyright T3 Tools", "packages/example/LICENSE")).toEqual([]);
    expect(lines("sha512-abcT3Yr5W0", "pnpm-lock.yaml")).toEqual([]);
    expect(
      lines("t3code", "packages/agent-runtime/src/orchestration-v2/testkit/fixtures/x/a.ndjson"),
    ).toEqual([]);
  });
});
