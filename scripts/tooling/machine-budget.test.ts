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
import { vitestRunWeight } from "./vitest-machine-budget-reporter.ts";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "nodex-machine-budget-"));
});
afterEach(async () => {
  await rm(directory, { force: true, recursive: true });
});

const ticket = (id: string, weight: number, enqueuedAt: number, granted = false): BudgetTicket => ({
  id,
  pid: 1,
  weight,
  label: id,
  cwd: "/repo",
  enqueuedAt,
  grantedAt: granted ? enqueuedAt : null,
});

const context = (overrides: Partial<BudgetContext> = {}): BudgetContext => ({
  env: {},
  cwd: "/repo/worktree",
  directory,
  capacity: 4,
  pollIntervalMs: 5,
  log: () => undefined,
  ...overrides,
});

const settled = async (promise: Promise<unknown>, withinMs = 60): Promise<boolean> =>
  Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), withinMs)),
  ]);

test("admits waiting claims in order while they fit", () => {
  const tickets = [ticket("held", 2, 1, true), ticket("a", 1, 2), ticket("b", 1, 3)];
  expect([...admittedTickets(tickets, 4)]).toEqual(["a", "b"]);
});

test("does not let a small claim overtake a large one that is waiting", () => {
  const tickets = [ticket("held", 2, 1, true), ticket("large", 4, 2), ticket("small", 1, 3)];
  expect([...admittedTickets(tickets, 4)]).toEqual([]);
});

test("treats a claim larger than the computer as exclusive instead of unsatisfiable", () => {
  expect([...admittedTickets([ticket("huge", 64, 1), ticket("next", 1, 2)], 4)]).toEqual(["huge"]);
});

test("queues a claim until an earlier holder releases", async () => {
  const lines: string[] = [];
  const first = await acquireMachineBudget({ weight: 3, label: "first" }, context());
  const second = acquireMachineBudget(
    { weight: 2, label: "second" },
    context({ log: (line) => lines.push(line) }),
  );
  expect(await settled(second)).toBe(false);
  expect(lines[0]).toContain("second is waiting");
  expect(lines[0]).toContain("3/4 cores in use by first in worktree");

  first.release();
  const lease = await second;
  expect(lease.waitedMs).toBeGreaterThan(0);
  lease.release();
  expect(await readdir(path.join(directory, "tickets"))).toEqual([]);
});

test("frees the share of a holder whose process died", async () => {
  const alive = new Set([101]);
  const isAlive = (pid: number) => alive.has(pid) || pid === process.pid;
  await acquireMachineBudget({ weight: 4, label: "killed" }, context({ pid: 101, isAlive }));
  const next = acquireMachineBudget({ weight: 1, label: "next" }, context({ isAlive }));
  expect(await settled(next)).toBe(false);

  alive.delete(101);
  (await next).release();
});

test("leaves the queue when cancelled while waiting", async () => {
  const holder = await acquireMachineBudget({ weight: 4, label: "holder" }, context());
  const controller = new AbortController();
  const waiting = acquireMachineBudget(
    { weight: 1, label: "waiting" },
    context({ signal: controller.signal }),
  );
  expect(await settled(waiting.catch(() => undefined))).toBe(false);
  controller.abort();
  await expect(waiting).rejects.toThrow("Cancelled");
  expect(await readdir(path.join(directory, "tickets"))).toHaveLength(1);
  holder.release();
});

test("commands started by a holder share its claim", async () => {
  const holder = await acquireMachineBudget({ weight: 4, label: "holder" }, context());
  const nested = await acquireMachineBudget(
    { weight: 4, label: "nested" },
    { env: holder.env, cwd: "/repo", directory, log: () => undefined },
  );
  expect(nested.waitedMs).toBe(0);
  holder.release();
});

test("is inactive on CI and when switched off, and accepts an explicit capacity", () => {
  expect(machineBudgetCapacity({ CI: "true" })).toBeNull();
  expect(machineBudgetCapacity({ NODEX_MACHINE_BUDGET: "off" })).toBeNull();
  expect(machineBudgetCapacity({ CI: "true", NODEX_MACHINE_BUDGET: "6" })).toBe(6);
  expect(() => machineBudgetCapacity({ NODEX_MACHINE_BUDGET: "many" })).toThrow("positive integer");
});

test("weighs a Vitest run by the workers it can start", () => {
  const run = {
    files: 40,
    maxWorkers: 4,
    browser: false,
    stress: false,
    capacity: 10,
  };
  expect(vitestRunWeight(run)).toBe(4);
  expect(vitestRunWeight({ ...run, files: 1 })).toBe(1);
  expect(vitestRunWeight({ ...run, maxWorkers: 1, browser: true })).toBe(2);
  expect(vitestRunWeight({ ...run, maxWorkers: 1, stress: true })).toBe(5);
});
