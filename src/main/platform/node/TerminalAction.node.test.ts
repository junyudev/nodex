import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { formatTerminalAction } from "./TerminalAction";

test("escapes the POSIX action directory and sends LF input", () => {
  expect(
    formatTerminalAction("/bin/zsh", "/tmp/Today's work", "one\r\ntwo\rthree\nfour", "linux"),
  ).toBe("cd '/tmp/Today'\\''s work' && one\ntwo\nthree\nfour\n");
});

test("uses a literal PowerShell directory and guards the action on successful navigation", () => {
  expect(
    formatTerminalAction(
      "C:\\PowerShell\\pwsh.exe",
      "C:\\Today's work",
      "one\r\ntwo\rthree\nfour",
      "win32",
    ),
  ).toBe(
    "Set-Location -LiteralPath 'C:\\Today''s work'; if ($?) {\r\none\r\ntwo\r\nthree\r\nfour\r\n}\r\n",
  );
});

test("switches drives for Command Prompt actions and sends CRLF input", () => {
  expect(
    formatTerminalAction(
      "C:\\Windows\\cmd.exe",
      'D:\\a "quoted" path',
      "one\r\ntwo\rthree\nfour",
      "win32",
    ),
  ).toBe('cd /d "D:\\a ""quoted"" path" && one\r\ntwo\r\nthree\r\nfour\r\n');
});

test.skipIf(process.platform === "win32")(
  "keeps a relative action directory anchored to the launcher's cwd",
  () => {
    const command = formatTerminalAction("/bin/sh", ".", "pwd -P", "linux");
    expect(execFileSync("/bin/sh", ["-c", command], { cwd: "/", encoding: "utf8" }).trim()).toBe(
      realpathSync("."),
    );
  },
);
