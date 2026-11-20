import { describe, expect, it } from "vitest";
import { classifyAskCommandStep } from "./ask-progress-command";

describe("Ask command progress", () => {
  it.each([
    ["nodex read PAGE", "read"],
    ["nodex fetch PAGE", "read"],
    ["nodex --project 'June review' discussions --json show ID", "read"],
    ["nodex --output-format=json sql query 'SELECT title FROM pages'", "query"],
    ["nodex page insert PAGE <<'BODY'\nA new paragraph.\nBODY", "write"],
    ["nodex patch --input changes.json", "write"],
    ["nodex update_page PAGE", "write"],
    ["nodex draft apply ./rewrite", "write"],
    ['"/Applications/Nodex Dev/bin/nodex" visual check chart.html', "visual"],
    ["cat <<'VISUAL' | nodex visual check -\n<html></html>\nVISUAL", "visual"],
    ["cd ~/project && cat reply.json | nodex discussions reply ID --input -", "reply"],
    ["/bin/bash -lc 'nodex discussions reply ID'", "reply"],
  ])("classifies %s as %s", (command, label) => {
    expect(classifyAskCommandStep(command)).toBe(label);
  });

  it.each([
    "git status",
    "nodex visual export chart.html",
    "nodex work resume --page ID",
    'echo "try this; nodex patch --input changes.json"',
    "echo '&&' nodex patch",
    "# nodex patch --input changes.json",
    "cat <<'BODY'\nnodex patch --input changes.json\nBODY",
  ])("keeps %s as a command", (command) => {
    expect(classifyAskCommandStep(command)).toBe("command");
  });
});
