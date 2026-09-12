import { expect, test } from "vitest";
import { codexCliAppServerArgs } from "./codex-app-server-launch";

test("desktop launch enables the native host and preserves explicit endpoint override values", () => {
  expect(codexCliAppServerArgs()).toEqual([
    "-c",
    "features.code_mode_host=true",
    "app-server",
    "--analytics-default-enabled",
  ]);
  expect(
    codexCliAppServerArgs({
      CODEX_APP_SERVER_CHATGPT_BASE_URL: ' https://example.test/"quoted" ',
      CODEX_APP_SERVER_OPENAI_BASE_URL: " ",
    }),
  ).toEqual([
    "app-server",
    "-c",
    "features.code_mode_host=true",
    "-c",
    'chatgpt_base_url="https://example.test/\\"quoted\\""',
    "--analytics-default-enabled",
  ]);
});
