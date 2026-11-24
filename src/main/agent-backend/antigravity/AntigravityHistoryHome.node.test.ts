import { expect, it } from "vitest";
import { antigravityHistoryHome } from "./AntigravityHistoryHome";

it("resolves Antigravity's history root from the host home", () => {
  const onWindows = (environment: NodeJS.ProcessEnv) =>
    antigravityHistoryHome({ platform: "win32", environment, homeDirectory: "C:\\Fallback" });
  expect(onWindows({ USERPROFILE: "D:\\Person", HOMEDRIVE: "E:", HOMEPATH: "\\Other" })).toBe(
    "D:\\Person\\.gemini",
  );
  expect(onWindows({ HomeDrive: "E:", HomePath: "\\Person", HOME: "/ignored" })).toBe(
    "E:\\Person\\.gemini",
  );
  expect(onWindows({ HOME: "/ignored" })).toBe("C:\\Fallback\\.gemini");
  const onMac = (environment: NodeJS.ProcessEnv) =>
    antigravityHistoryHome({ platform: "darwin", environment, homeDirectory: "/fallback" });
  expect(onMac({ HOME: "/person", GEMINI_HOME: "/isolated" })).toBe("/person/.gemini");
  expect(onMac({ HOME: "" })).toBe("/fallback/.gemini");
});
