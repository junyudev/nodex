import { describe, expect, test } from "vite-plus/test";
import {
  buildAppFilesystemPath,
  buildAppFilesystemUrl,
  buildEnvironmentAwareFilesystemUrl,
  isAbsoluteAppFilesystemPath,
  normalizeAppFilesystemPath,
  restoreNativeAppFilesystemPath,
} from "./app-protocol";

describe("app filesystem URL codec", () => {
  test.each([
    ["/Users/asc/My Image #1?.png", "/@fs/Users/asc/My%20Image%20%231%3F.png"],
    ["/tmp/你好.png", "/@fs/tmp/%E4%BD%A0%E5%A5%BD.png"],
    ["C:\\Users\\asc\\image.png", "/@fs/C:/Users/asc/image.png"],
    ["/C:/Users/asc/image.png", "/@fs/C:/Users/asc/image.png"],
    ["\\\\server\\share\\image.png", "/@fs//server/share/image.png"],
    ["mixed\\folder/image%20name.png", "/@fsmixed/folder/image%2520name.png"],
    ["", "/@fs"],
  ])("encodes %s without applying source authorization", (filePath, expected) => {
    expect(buildAppFilesystemPath(filePath)).toBe(expected);
  });

  test("builds full and environment-aware URLs", () => {
    expect(buildAppFilesystemUrl("/tmp/image.png")).toBe("app://fs/@fs/tmp/image.png");
    expect(buildEnvironmentAwareFilesystemUrl("/tmp/image.png", "http:")).toBe(
      "/@fs/tmp/image.png",
    );
    expect(buildEnvironmentAwareFilesystemUrl("/tmp/image.png", "https:")).toBe(
      "/@fs/tmp/image.png",
    );
    expect(buildEnvironmentAwareFilesystemUrl("/tmp/image.png", "app:")).toBe(
      "app://fs/@fs/tmp/image.png",
    );
  });

  test("keeps codec normalization and absolute-path authorization separate", () => {
    expect(normalizeAppFilesystemPath("C:\\work/mixed\\image.png")).toBe(
      "/C:/work/mixed/image.png",
    );
    expect(isAbsoluteAppFilesystemPath("/tmp/image.png")).toBe(true);
    expect(isAbsoluteAppFilesystemPath("C:\\work\\image.png")).toBe(true);
    expect(isAbsoluteAppFilesystemPath("\\\\server\\share\\image.png")).toBe(true);
    expect(isAbsoluteAppFilesystemPath("//server/share/image.png")).toBe(true);
    expect(isAbsoluteAppFilesystemPath("relative/image.png")).toBe(false);
    expect(isAbsoluteAppFilesystemPath("//not-a-complete-unc")).toBe(false);
  });

  test("removes exactly one renderer drive slash and preserves other paths", () => {
    expect(restoreNativeAppFilesystemPath("/C:/work/image.png")).toBe("C:/work/image.png");
    expect(restoreNativeAppFilesystemPath("//server/share/image.png")).toBe(
      "//server/share/image.png",
    );
    expect(restoreNativeAppFilesystemPath("/tmp/image.png")).toBe("/tmp/image.png");
  });
});

test.each(["C:\\media\\image.png", "D:/media/image.png", "\\\\server\\share\\image.png"])(
  "keeps Windows media on the native protocol in development: %s",
  (path) => {
    expect(buildEnvironmentAwareFilesystemUrl(path, "http:")).toBe(buildAppFilesystemUrl(path));
    expect(buildEnvironmentAwareFilesystemUrl(path, "https:")).toBe(buildAppFilesystemUrl(path));
  },
);
