import { expect, test, vi } from "vitest";
import { createDictationDictionarySession } from "./dictation-dictionary-runtime";
const mocks = vi.hoisted(() => ({ query: vi.fn(), command: vi.fn(), control: vi.fn() }));
vi.mock("@/lib/renderer-command", () => ({
  defineRendererCommand: (value: unknown) => value,
  invokeRendererQuery: mocks.query,
  invokePlainCommand: mocks.command,
  invokeRendererControl: mocks.control,
}));
const target = { accountId: "account-a", userId: "user-a" };
const snapshot = { target, words: [], maxWords: 200, localWords: [] };

test("captures the initial account and keeps subsequent reads and mutations bound to it", async () => {
  mocks.query.mockResolvedValue(snapshot);
  mocks.command.mockResolvedValue(undefined);
  const session = createDictationDictionarySession();
  await session.read();
  await session.read();
  await session.add("Nodex");
  expect(mocks.query.mock.calls.at(-1)?.[1].target).toEqual(target);
  expect(mocks.command.mock.calls.at(-1)?.[1]).toMatchObject({ target, text: "Nodex" });
});

test("cancels active operations on close and rejects their late results", async () => {
  let complete!: (value: typeof snapshot) => void;
  mocks.query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  mocks.control.mockResolvedValue(true);
  const session = createDictationDictionarySession();
  const result = session.read();
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  const operationId = mocks.query.mock.calls.at(-1)?.[1].operationId;
  session.dispose();
  complete(snapshot);
  await rejected;
  expect(mocks.control).toHaveBeenCalledWith("codex:dictation:dictionary:cancel", operationId);
  await expect(session.add("late")).rejects.toMatchObject({ name: "AbortError" });
});

test("effect remounts can reactivate a session while cancelled results stay fenced", async () => {
  mocks.query.mockResolvedValue(snapshot);
  const session = createDictationDictionarySession();
  await session.read();
  let complete!: (value: typeof snapshot) => void;
  mocks.query.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const result = session.read();
  const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
  session.dispose();
  session.activate();
  complete(snapshot);
  await rejected;
  await expect(session.read()).resolves.toEqual(snapshot);
});
