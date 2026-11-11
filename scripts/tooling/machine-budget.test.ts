import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import {
  acquireMachineBudget,
  admittedTickets,
  machineBudgetCapacity,
  type BudgetContext,
  type BudgetTicket,
} from "./machine-budget.ts";
import { vitestRunClaim } from "./vitest-machine-budget-reporter.ts";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "nodex-machine-budget-"));
});
afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

const ticket = (
  id: string,
  weight: number,
  enqueuedAt: number,
  granted = false,
  memoryGiB = 1,
): BudgetTicket => ({
  id,
  pid: 1,
  weight,
  memoryGiB,
  label: id,
  cwd: "/repo",
  enqueuedAt,
  grantedAt: granted ? enqueuedAt : null,
});

const context = (overrides: Partial<BudgetContext> = {}): BudgetContext => ({
  env: {},
  cwd: "/repo/worktree",
  directory,
  capacity: { cores: 4, memoryGiB: 16 },
  memoryPressure: () => false,
  pollIntervalMs: 5,
  log: () => undefined,
  ...overrides,
});

const settled = async (promise: Promise<unknown>, withinMs = 60): Promise<boolean> =>
  Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), withinMs)),
  ]);

const capacity = { cores: 4, memoryGiB: 16 };

test("admits waiting claims in order while they fit", () => {
  const tickets = [ticket("held", 2, 1, true), ticket("a", 1, 2), ticket("b", 1, 3)];
  expect([...admittedTickets(tickets, capacity)]).toEqual(["a", "b"]);
});

test("does not let a small claim overtake a large one that is waiting", () => {
  const tickets = [ticket("held", 2, 1, true), ticket("large", 4, 2), ticket("small", 1, 3)];
  expect([...admittedTickets(tickets, capacity)]).toEqual([]);
});

test("treats a claim larger than the computer as exclusive instead of unsatisfiable", () => {
  expect([...admittedTickets([ticket("huge", 64, 1), ticket("next", 1, 2)], capacity)]).toEqual([
    "huge",
  ]);
});

test("holds a claim whose memory does not fit beside the running ones", () => {
  const tickets = [ticket("compiler", 1, 1, true, 11), ticket("second", 1, 2, false, 11)];
  expect([...admittedTickets(tickets, capacity)]).toEqual([]);
  expect([...admittedTickets([tickets[1]!], capacity)]).toEqual(["second"]);
});

test("counts no memory for claims written before memory accounting", () => {
  const { memoryGiB: _, ...legacy } = ticket("legacy", 1, 1, true);
  expect([...admittedTickets([legacy, ticket("next", 1, 2, false, 16)], capacity)]).toEqual([
    "next",
  ]);
});

test("runs claims one at a time while the computer is short of memory", () => {
  const waiting = [ticket("a", 1, 1), ticket("b", 1, 2)];
  expect([...admittedTickets(waiting, capacity, true)]).toEqual(["a"]);
  expect([...admittedTickets([ticket("held", 1, 0, true), ...waiting], capacity, true)]).toEqual(
    [],
  );
});

test("queues a claim until an earlier holder releases", async () => {
  const lines: string[] = [];
  const first = await acquireMachineBudget({ weight: 3, memoryGiB: 2, label: "first" }, context());
  const second = acquireMachineBudget(
    { weight: 2, memoryGiB: 2, label: "second" },
    context({ log: (line) => lines.push(line) }),
  );
  expect(await settled(second)).toBe(false);
  expect(lines[0]).toContain("second is waiting");
  expect(lines[0]).toContain("3/4 cores and 2/16 GiB in use by first in worktree");

  first.release();
  const lease = await second;
  expect(lease.waitedMs).toBeGreaterThan(0);
  lease.release();
  expect(await readdir(path.join(directory, "tickets"))).toEqual([]);
});

test("frees the share of a holder whose process died", async () => {
  const alive = new Set([101]);
  const isAlive = (pid: number) => alive.has(pid) || pid === process.pid;
  await acquireMachineBudget(
    { weight: 4, memoryGiB: 1, label: "killed" },
    context({ pid: 101, isAlive }),
  );
  const next = acquireMachineBudget(
    { weight: 1, memoryGiB: 1, label: "next" },
    context({ isAlive }),
  );
  expect(await settled(next)).toBe(false);

  alive.delete(101);
  (await next).release();
});

test("waits for the computer to recover before starting beside a running claim", async () => {
  let pressure = true;
  const first = await acquireMachineBudget({ weight: 1, memoryGiB: 1, label: "first" }, context());
  const lines: string[] = [];
  const second = acquireMachineBudget(
    { weight: 1, memoryGiB: 1, label: "second" },
    context({ memoryPressure: () => pressure, log: (line) => lines.push(line) }),
  );
  expect(await settled(second)).toBe(false);
  expect(lines[0]).toContain("short of memory");

  pressure = false;
  (await second).release();
  first.release();
});

test("leaves the queue when cancelled while waiting", async () => {
  const holder = await acquireMachineBudget(
    { weight: 4, memoryGiB: 1, label: "holder" },
    context(),
  );
  const controller = new AbortController();
  const waiting = acquireMachineBudget(
    { weight: 1, memoryGiB: 1, label: "waiting" },
    context({ signal: controller.signal }),
  );
  expect(await settled(waiting.catch(() => undefined))).toBe(false);
  controller.abort();
  await expect(waiting).rejects.toThrow("Cancelled");
  expect(await readdir(path.join(directory, "tickets"))).toHaveLength(1);
  holder.release();
});

test("commands started by a holder share its claim", async () => {
  const holder = await acquireMachineBudget(
    { weight: 4, memoryGiB: 1, label: "holder" },
    context(),
  );
  const nested = await acquireMachineBudget(
    { weight: 4, memoryGiB: 1, label: "nested" },
    { env: holder.env, cwd: "/repo", directory, log: () => undefined },
  );
  expect(nested.waitedMs).toBe(0);
  holder.release();
});

test("is inactive on CI and when switched off, and accepts an explicit capacity", () => {
  expect(machineBudgetCapacity({ CI: "true" })).toBeNull();
  expect(machineBudgetCapacity({ NODEX_MACHINE_BUDGET: "off" })).toBeNull();
  expect(
    machineBudgetCapacity({
      CI: "true",
      NODEX_MACHINE_BUDGET: "6",
      NODEX_MACHINE_BUDGET_MEMORY_GB: "8",
    }),
  ).toEqual({ cores: 6, memoryGiB: 8 });
  expect(() => machineBudgetCapacity({ NODEX_MACHINE_BUDGET: "many" })).toThrow("positive integer");
});

test("claims cores and memory for the workers a Vitest run can start", () => {
  const run = { files: 40, maxWorkers: 4, runtime: "dom", stress: false, cores: 10 } as const;
  expect(vitestRunClaim(run)).toEqual({ weight: 4, memoryGiB: 5 });
  expect(vitestRunClaim({ ...run, files: 1, runtime: "node" })).toEqual({
    weight: 1,
    memoryGiB: 1,
  });
  expect(vitestRunClaim({ ...run, maxWorkers: 1, runtime: "browser" })).toEqual({
    weight: 2,
    memoryGiB: 4,
  });
  expect(vitestRunClaim({ ...run, maxWorkers: 1, stress: true }).weight).toBe(5);
});
