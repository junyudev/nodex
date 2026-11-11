import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const [behavior, file] = process.argv.slice(2);
const esc = "\x1b";
const write = (data) => process.stdout.write(data);

function enterRawMode() {
  process.stdin.setRawMode(true);
  // Node makes stdin raw but leaves PTY output processing enabled.
  execFileSync("stty", ["-opost"], { stdio: ["inherit", "ignore", "inherit"] });
}

switch (behavior) {
  case "environment": {
    const keys = [
      "NO_COLOR", "TERM", "COLORTERM", "PAGER", "GIT_PAGER", "AGENT",
      "CODEX_THREAD_ID", "TMUX", "TERM_PROGRAM", "NODEX_TEST_SURVIVOR", "NODEX_TEST_LOGIN", "NODEX_TEST_SHELL_MODE",
    ];
    const values = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));
    writeFileSync(file, JSON.stringify(values));
    break;
  }
  case "color": {
    const { NO_COLOR, COLORTERM, TERM } = process.env;
    const colors = NO_COLOR ? "disabled" :
      /^(truecolor|24bit)$/i.test(COLORTERM ?? "") || TERM?.endsWith("256color") ? "enabled" : "disabled";
    write(`\r\ncolors=${colors} ${esc}[34;42mINDEXED${esc}[0m ${esc}[38;2;17;123;231;48;2;80;18;40mTRUECOLOR${esc}[0m\r\n`);
    break;
  }
  case "lf": {
    enterRawMode();
    process.stdin.resume();
    write(esc + "[2J" + esc + "[3;10HX\nY");
    break;
  }
  case "alternate": {
    enterRawMode();
    process.stdin.on("data", (bytes) => appendFileSync(file, bytes));
    let redraws = 0;
    const draw = () => write(
      esc + "[2J" + esc + "[H" + esc + "[34;42mALTERNATE CONTENT" + esc + "[0m\r\n" +
      `REDRAWS=${redraws} SIZE=${process.stdout.columns}x${process.stdout.rows}`,
    );
    process.on("SIGWINCH", () => {
      redraws++;
      draw();
    });
    // Keep the startup queries in the replay tail after the alternate-screen entry falls out.
    write(esc + "[?1049h" + ("f".repeat(64) + "\r\n").repeat(300));
    write(esc + "[3;10H" + esc + "[6n" + esc + "[c");
    draw();
    break;
  }
  case "clear": {
    enterRawMode();
    process.stdin.on("data", (bytes) => {
      if (bytes.includes("!")) write("AFTER-CLEAR\r\n");
    });
    write(esc + "[2J" + esc + "[HBEFORE-CLEAR\r\n");
    break;
  }
  case "paste": {
    enterRawMode();
    process.stdin.on("data", (bytes) => appendFileSync(file, bytes));
    write(esc + "[?2004h" + esc + "[2J" + esc + "[HTERMINAL-COPY-SELECTION");
    break;
  }
  case "load": {
    enterRawMode();
    process.stdin.on("data", (bytes) => {
      if (bytes.includes("!")) write("INPUT-ACCEPTED\r\n");
    });
    // 80,000 * 50 bytes. Each logical line fits without wrapping on the test window.
    write(Array.from({ length: 80_000 }, (_, i) =>
      `BURST ${String(i + 1).padStart(6, "0")} ${"x".repeat(35)}\r\n`,
    ).join("") + "BURST-DONE\r\n");
    break;
  }
  case "title": {
    enterRawMode();
    process.stdin.on("data", (bytes) => {
      if (bytes.includes("!")) write(esc + "]2;" + process.cwd() + "\x07");
    });
    write(esc + "]2;hello-title\x07");
    break;
  }
  default:
    throw new Error(`Unknown terminal fixture: ${behavior}`);
}
