import { expect, test } from "vite-plus/test";
import { sanitizeNativeSaveFileName, WorkspaceFileSaveDataInputSchema } from "./native-file-save";

test("native save names preserve extensions and Unicode within filesystem byte limits", () => {
  expect(sanitizeNativeSaveFileName("folder/a:*?.png. ")).toBe("folder_a___.png");
  expect(sanitizeNativeSaveFileName("CON.png")).toBe("_CON.png");
  expect(sanitizeNativeSaveFileName("...")).toBe("_");
  const name = sanitizeNativeSaveFileName(`${"图片🌅".repeat(100)} (2x)-12.webp`);
  expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(254);
  expect(name.endsWith(" (2x)-12.webp")).toBe(true);
  expect(name.includes("�")).toBe(false);
  expect(
    WorkspaceFileSaveDataInputSchema.safeParse({ fileName: "a.png", contentsBase64: "invalid!" })
      .success,
  ).toBe(false);
});
