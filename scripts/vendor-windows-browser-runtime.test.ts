import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { fixtureWindowsPe } from "../src/main/codex/browser-runtime-windows-test-fixture";
import { vendorWindowsBrowserRuntime } from "./vendor-windows-browser-runtime";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

function fixtureRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "nodex-msix-fixture-")));
  roots.push(root);
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(packageRoot);
  return {
    packageRoot,
    outputPath: path.join(root, "closure"),
    codexCompatibilityVersion: "1.0.0",
    root,
  };
}

function makeCertificate(root: string) {
  const run = (args: string[]) =>
    execFileSync("openssl", args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  run([
    "req",
    "-new",
    "-x509",
    "-nodes",
    "-newkey",
    "rsa:2048",
    "-subj",
    "/C=US/O=Microsoft Corporation/CN=Microsoft ID Verified CS AOC CA 04",
    "-keyout",
    "issuer.key",
    "-out",
    "issuer.pem",
    "-days",
    "1",
  ]);
  run([
    "req",
    "-new",
    "-nodes",
    "-newkey",
    "rsa:2048",
    "-subj",
    "/C=US/ST=California/L=San Francisco/O=OpenAI OpCo, LLC/CN=OpenAI OpCo, LLC",
    "-keyout",
    "leaf.key",
    "-out",
    "leaf.csr",
  ]);
  run([
    "x509",
    "-req",
    "-in",
    "leaf.csr",
    "-CA",
    "issuer.pem",
    "-CAkey",
    "issuer.key",
    "-set_serial",
    "1",
    "-out",
    "leaf.pem",
    "-days",
    "1",
  ]);
  fs.writeFileSync(path.join(root, "message"), "synthetic PE certificate payload");
  return run([
    "smime",
    "-sign",
    "-in",
    "message",
    "-signer",
    "leaf.pem",
    "-inkey",
    "leaf.key",
    "-outform",
    "DER",
    "-nodetach",
  ]);
}

describe.skipIf(process.platform !== "darwin")("vendoring an extracted Windows package", () => {
  test("selects the matching closure and checks BlockMap bytes before publishing", () => {
    const options = fixtureRoot();
    const { packageRoot, outputPath, root } = options;
    const certificate = makeCertificate(root);
    const arch = "arm64";
    const pe = fixtureWindowsPe(arch, certificate);
    const modules = "cua_node/bin/node_modules";
    const plugins = "plugins/openai-bundled/plugins";
    const helper = "codex-computer-use-arm64.exe";
    const entries = new Map<string, string | Buffer>();
    const add = (relative: string, bytes: string | Buffer) =>
      entries.set(`app/resources/${relative}`, bytes);
    entries.set(
      "AppxManifest.xml",
      '<Package><Identity Name="OpenAI.Codex" ProcessorArchitecture="arm64" Version="1.0.0.0" Publisher="CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B"/></Package>',
    );
    add("owl-app.ini", "AppVersion=1.0.0\n");
    add(
      "cua_node/manifest.json",
      JSON.stringify({
        target: "windows-arm64",
        platform: "windows",
        arch,
        node_path: "bin/node.exe",
        node_repl_path: "bin/node_repl.exe",
        node_modules: "bin/node_modules",
        node_binary_version: "24.0.0",
        runtime_archive_version: "1.0.0/build",
      }),
    );
    for (const file of [
      "codex.exe",
      "codex-code-mode-host.exe",
      "codex-command-runner.exe",
      "codex-windows-sandbox-service.exe",
      "codex-windows-sandbox-setup.exe",
      "cua_node/bin/node.exe",
      "cua_node/bin/node_repl.exe",
      "native/windows-account.node",
      `${modules}/@oai/cua/bin/windows/${helper}`,
      `${modules}/@oai/sky/bin/windows/${helper}`,
      ...["codex-computer-use-swift.exe", "MSVCP140.dll", "VCRUNTIME140.dll"].map(
        (file) => `${modules}/@oai/sky/bin/windows/swift/arm64/${file}`,
      ),
      `${plugins}/chrome/extension-host/windows/arm64/extension-host.exe`,
    ])
      add(file, pe);
    add(
      `${modules}/classic-level/prebuilds/win32-x64/classic-level.node`,
      fixtureWindowsPe("x64", certificate),
    );
    add("native/windows-updater.node", pe);
    for (const plugin of ["browser", "chrome", "computer-use"]) {
      add(`${plugins}/${plugin}/.codex-plugin/plugin.json`, '{"version":"1.0.0"}');
    }
    for (const file of [
      "browser/scripts/browser-client.mjs",
      "browser/scripts/browser-service.mjs",
      "browser/skills/control-in-app-browser/SKILL.md",
      "browser/node_modules/entry.mjs",
      "chrome/scripts/installManifest.mjs",
      "computer-use/skills/computer-use/SKILL.md",
    ])
      add(`${plugins}/${file}`, "fixture");
    add(
      `${plugins}/chrome/scripts/extension-ids.json`,
      JSON.stringify({
        extensionIds: ["a".repeat(32)],
        extensionHostName: "com.openai.codexextension",
      }),
    );
    const blocks = [];
    for (const [relative, contents] of entries) {
      const file = path.join(packageRoot, relative.replaceAll("@", "%40"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents);
      const digest = createHash("sha256").update(contents).digest("base64");
      blocks.push(
        `<File Name="${relative.replaceAll("/", "\\")}" Size="${Buffer.byteLength(contents)}"><Block Hash="${digest}"/></File>`,
      );
    }
    fs.writeFileSync(
      path.join(packageRoot, "AppxBlockMap.xml"),
      `<BlockMap HashMethod="http://www.w3.org/2001/04/xmlenc#sha256">${blocks.join("")}</BlockMap>`,
    );
    const result = vendorWindowsBrowserRuntime({ ...options, targetArch: arch });
    expect(result.capabilities.computerUse.serviceExecutable).toContain(helper);
    expect(Object.keys(result.trust.pe)).toContain("native/windows-account.node");
    expect(result.artifacts.some(({ path: relative }) => /win32-x64|updater/u.test(relative))).toBe(
      false,
    );
    expect(fs.readFileSync(path.join(outputPath, result.entrypoints.codexCli))).toEqual(pe);
    fs.appendFileSync(path.join(packageRoot, "app/resources/codex.exe"), "changed");
    expect(() => vendorWindowsBrowserRuntime({ ...options, targetArch: arch })).toThrow(
      "does not match BlockMap",
    );
    expect(fs.readFileSync(path.join(outputPath, result.entrypoints.codexCli))).toEqual(pe);
  });

  test.each([
    { name: "%2e%2e", error: "Unsafe Windows package path" },
    { name: "%2Ffoo", error: "Unsafe Windows package path" },
    { name: "%40pkg", error: "Windows package path alias" },
    { name: "link", error: "Unsupported Windows package entry" },
  ])("rejects $name before reading package metadata", ({ name, error }) => {
    const options = fixtureRoot();
    const file = path.join(options.packageRoot, name);
    if (name === "link") fs.symlinkSync(options.root, file);
    else fs.writeFileSync(file, "fixture");
    if (name === "%40pkg") fs.writeFileSync(path.join(options.packageRoot, "@pkg"), "alias");
    expect(() => vendorWindowsBrowserRuntime({ ...options, targetArch: "x64" })).toThrow(error);
  });
});
