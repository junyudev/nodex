import { describe, expect, test } from "vite-plus/test";
import {
  CODEX_DEFAULT_FEATURE_OVERRIDES,
  buildCodexThreadConfigOverrides,
} from "./codex-thread-capabilities";

describe("Codex thread capabilities", () => {
  test("defines one shared capability set for bare and protocol config keys", () => {
    expect(CODEX_DEFAULT_FEATURE_OVERRIDES).toEqual({});
    expect(buildCodexThreadConfigOverrides()).toEqual({});
  });
});
