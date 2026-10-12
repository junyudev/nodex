import { beforeEach, expect, it, vi } from "vitest";
import {
  readComposerPredictionsEnabled,
  subscribeComposerPredictionsEnabled,
  writeComposerPredictionsEnabled,
} from "./composer-prediction-settings";

const operation = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./local-conversation-operations", () => ({ runConversationOperation: operation }));

beforeEach(() => {
  localStorage.clear();
  operation.mockClear();
});

it("invalidates all hosts when the effective preference changes without a mounted Composer", () => {
  writeComposerPredictionsEnabled(false);
  expect(readComposerPredictionsEnabled()).toBe(false);
  expect(operation).toHaveBeenNthCalledWith(1, "codex:composer-prediction:clear");
  writeComposerPredictionsEnabled(true);
  expect(readComposerPredictionsEnabled()).toBe(true);
  expect(operation).toHaveBeenNthCalledWith(2, "codex:composer-prediction:clear");
  expect(operation).toHaveBeenCalledTimes(2);
});

it("notifies consuming owners only for effective changes while cache invalidation outlives subscriptions", () => {
  const changed = vi.fn();
  const unsubscribe = subscribeComposerPredictionsEnabled(changed);
  try {
    writeComposerPredictionsEnabled(true);
    expect(operation).not.toHaveBeenCalled();
    writeComposerPredictionsEnabled(false);
    writeComposerPredictionsEnabled(false);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(operation).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
  }
  writeComposerPredictionsEnabled(true);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(operation).toHaveBeenCalledTimes(2);
});
