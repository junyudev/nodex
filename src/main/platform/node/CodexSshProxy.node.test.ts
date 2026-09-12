import { execFileSync, spawn } from "node:child_process";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { once } from "node:events";
import { expect, test } from "vitest";
import {
  codexRemoteLoginCommand,
  codexSshConnectionArguments,
  createCodexSshProxy,
} from "./CodexSshProxy";

test("login wrapper preserves binary marker, payload quoting and explicit Codex home", () => {
  const marker = Buffer.from([0, 255, 39, 92, 10, 13, 65, 128]);
  const command = codexRemoteLoginCommand('printf "%s" "value with spaces"', marker);
  const result = execFileSync("/bin/sh", ["-c", command], {
    env: { ...process.env, SHELL: "/bin/sh" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  expect(result).toEqual(Buffer.concat([marker, Buffer.from("value with spaces")]));
});

test("alias selection takes precedence over direct SSH connection fields", () => {
  const args = codexSshConnectionArguments(
    { alias: " saved-host ", host: "ignored", identity: "key", port: 99 },
    20,
  );
  expect(args.slice(-1)).toEqual(["saved-host"]);
  expect(args).not.toContain("key");
  expect(
    codexSshConnectionArguments({ host: "example", identity: " key ", port: 22 }).slice(-5),
  ).toEqual(["-i", "key", "-p", "22", "example"]);
});

it.effect("proxy strips split login marker and preserves handshake bytes", () => Effect.gen(function* () {
  const marker = Buffer.from("12345678");
  const proxy = createCodexSshProxy({
    connection: { host: "unused" },
    sentinel: marker,
    spawnProcess: (() =>
      spawn(
        process.execPath,
        [
          "-e",
          'process.stdout.write("login noise1234"); setTimeout(()=>{process.stdout.write("5678HTTP/1.1 101\\r\\n");process.stdout.end();},10)',
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      )),
  });
  const chunks: Buffer[] = [];
  proxy.on("data", (chunk: Buffer) => chunks.push(chunk));
  try {
    yield* Effect.promise(() => once(proxy, "end"));
    expect(Buffer.concat(chunks).toString()).toBe("HTTP/1.1 101\r\n");
  } finally {
    proxy.destroy();
  }
}));
