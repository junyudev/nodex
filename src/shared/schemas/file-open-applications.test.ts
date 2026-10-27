import { expect, test } from "vite-plus/test";
import {
  FileOpenApplicationsInputSchema,
  OpenFileWithApplicationInputSchema,
} from "./file-open-applications";

test("preserves exact absolute filenames and admits only application bundle paths", () => {
  const path = "/workspace/review.webm ";
  expect(FileOpenApplicationsInputSchema.parse({ path })).toEqual({ path });
  expect(
    OpenFileWithApplicationInputSchema.parse({
      path,
      appPath: "/System/Applications/QuickTime Player.app",
    }),
  ).toEqual({ path, appPath: "/System/Applications/QuickTime Player.app" });
  for (const input of [
    { path: "relative" },
    { path: "" },
    { path: "file:///tmp/review.webm" },
    { path: "/tmp/invalid\0" },
    { path, hostId: "ssh:remote" },
  ])
    expect(FileOpenApplicationsInputSchema.safeParse(input).success).toBe(false);
  for (const appPath of [
    "QuickTime Player",
    "/tmp/player",
    "/tmp/Player.app/Contents/MacOS/player",
  ])
    expect(OpenFileWithApplicationInputSchema.safeParse({ path, appPath }).success).toBe(false);
});
