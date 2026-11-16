import { expect, test } from "vite-plus/test";

import { notarize, type NotaryClient, type NotaryResult } from "./notarization";

const ok = (value: Record<string, unknown>): NotaryResult => ({ ok: true, value });
const failed = (detail: string): NotaryResult => ({ ok: false, detail });

function client(script: {
  submit?: NotaryResult[];
  wait?: NotaryResult[];
  info?: NotaryResult[];
  log?: NotaryResult;
}) {
  const calls: string[] = [];
  const next = (name: string, queue: NotaryResult[] | undefined) => {
    calls.push(name);
    const result = queue?.shift();
    if (!result) throw new Error(`Unexpected ${name} call`);
    return result;
  };
  const notary: NotaryClient = {
    submit: () => next("submit", script.submit),
    wait: (id) => next(`wait ${id}`, script.wait),
    info: (id) => next(`info ${id}`, script.info),
    log: (id) => next(`log ${id}`, script.log ? [script.log] : undefined),
  };
  return { notary, calls };
}

const quiet = { report: () => {} };

test("submits again only when an upload never produced a submission", () => {
  const { notary, calls } = client({
    submit: [failed("exited with 1"), ok({ id: "second" })],
    wait: [ok({ status: "Accepted" })],
    info: [ok({ status: "Accepted" })],
  });
  expect(notarize(notary, "Nodex.dmg", quiet)).toBe("second");
  expect(calls).toEqual(["submit", "submit", "wait second", "info second"]);
});

test("keeps following the same submission when waiting drops", () => {
  const { notary, calls } = client({
    submit: [ok({ id: "one" })],
    wait: [failed("stopped by SIGPIPE"), ok({ status: "Accepted" })],
    info: [ok({ status: "In Progress" }), ok({ status: "Accepted" })],
  });
  expect(notarize(notary, "Nodex.dmg", quiet)).toBe("one");
  expect(calls).toEqual(["submit", "wait one", "info one", "wait one", "info one"]);
});

test("trusts Apple's record over the wait call's own exit", () => {
  const { notary } = client({
    submit: [ok({ id: "one" })],
    wait: [failed("exited with 1")],
    info: [ok({ status: "Accepted" })],
  });
  expect(notarize(notary, "Nodex.dmg", quiet)).toBe("one");
});

test("prints Apple's log and stops when Apple rejects the file", () => {
  const lines: string[] = [];
  const { notary, calls } = client({
    submit: [ok({ id: "one" })],
    wait: [ok({ status: "Invalid" })],
    info: [ok({ status: "Invalid" })],
    log: ok({ issues: [{ message: "The binary is not signed." }] }),
  });
  expect(() => notarize(notary, "Nodex.dmg", { report: (line) => lines.push(line) })).toThrow(
    "Apple invalid notarization submission one.",
  );
  expect(calls).toEqual(["submit", "wait one", "info one", "log one"]);
  expect(lines.join("\n")).toContain("The binary is not signed.");
});

test("gives up with the last failure once every attempt is spent", () => {
  const { notary } = client({
    submit: [failed("a"), failed("b"), failed("network connection was lost")],
  });
  expect(() => notarize(notary, "Nodex.dmg", quiet)).toThrow(
    "Notarization upload failed after 3 attempts: network connection was lost",
  );
  const waiting = client({
    submit: [ok({ id: "one" })],
    wait: [failed("x"), failed("y"), failed("timed out")],
    info: [failed("x"), failed("y"), ok({ status: "In Progress" })],
  });
  expect(() => notarize(waiting.notary, "Nodex.dmg", quiet)).toThrow(
    "Notarization submission one did not finish: timed out",
  );
});
