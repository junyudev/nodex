import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  buildComputerUseRuntimeConfig,
  computerUseNativePipePath,
  writeComputerUseRuntimeConfig,
} from "./computer-use-runtime-config";

const temporaryRoots: string[] = [];

function makeTemporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-cua-config-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("Computer Use runtime config", () => {
  test("isolates native sockets by Profile while bounding Unix socket path length", () => {
    const firstProfile = path.join(makeTemporaryRoot(), "first");
    const firstSocket = computerUseNativePipePath(firstProfile);
    expect(computerUseNativePipePath(path.join(firstProfile, "nested", ".."))).toBe(firstSocket);
    expect(computerUseNativePipePath(`${firstProfile}-other`)).not.toBe(firstSocket);
    expect(Buffer.byteLength(firstSocket)).toBeLessThanOrEqual(103);
    expect(
      Buffer.byteLength(computerUseNativePipePath(`/profiles/${"long/".repeat(200)}`)),
    ).toBeLessThanOrEqual(103);
  });

  test("resolves locale strings, direction, and a validated accent", () => {
    const localesDirectory = path.join(makeTemporaryRoot(), "locales");
    fs.mkdirSync(localesDirectory);
    fs.writeFileSync(
      path.join(localesDirectory, "ar.json"),
      JSON.stringify({
        "computerUseOverlay.escToCancel": "اضغط Esc للإلغاء",
        "computerUseOverlay.usingComputer": "يستخدم Nodex جهاز الكمبيوتر الخاص بك",
      }),
    );

    expect(
      buildComputerUseRuntimeConfig({
        accentColor: "#12aBcD",
        locale: "ar-EG",
        localesDirectory,
      }),
    ).toEqual({
      accentColor: "#12aBcD",
      direction: "rtl",
      locale: "ar-EG",
      strings: {
        escToCancel: "اضغط Esc للإلغاء",
        usingComputer: "يستخدم Nodex جهاز الكمبيوتر الخاص بك",
      },
    });
  });

  test("atomically writes the canonical CODEX_HOME config", async () => {
    const runtimeStateHome = makeTemporaryRoot();
    await writeComputerUseRuntimeConfig({
      locale: "zh-CN",
      runtimeStateHome,
      strings: {
        escToCancel: "按 Esc 取消",
        usingComputer: "Nodex 正在使用你的电脑",
      },
    });

    const directory = path.join(runtimeStateHome, "computer-use");
    const config = JSON.parse(
      fs.readFileSync(path.join(directory, "config.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(config).toEqual({
      accentColor: "#339cff",
      direction: "ltr",
      locale: "zh-CN",
      strings: {
        escToCancel: "按 Esc 取消",
        usingComputer: "Nodex 正在使用你的电脑",
      },
    });
    expect(fs.readdirSync(directory).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });
});
