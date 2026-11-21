import { act, fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { agentRuntimeProviderId } from "../../../shared/agent-runtime-provider";
import {
  antigravityInspection,
  antigravityOperation,
  managedAntigravityExecutable,
} from "../../../shared/antigravity-runtime.test-support";
import type {
  AntigravityRuntimeOwner,
  AntigravityRuntimeViewInput,
} from "./antigravity-runtime-owner";
import { AntigravityProfileExecutable, AntigravityRuntimeRow } from "./antigravity-runtime-status";

test("routes shared runtime actions through the owner and confirms removal", async () => {
  const profileId = "google-account";
  const inspection = antigravityInspection({
    managed: managedAntigravityExecutable,
    canRemove: true,
    instances: [
      {
        ...managedAntigravityExecutable,
        instanceId: agentRuntimeProviderId({ kind: "antigravity", instanceConfigId: profileId })!,
        configuredBinaryPath: null,
        issue: null,
      },
    ],
  });
  let snapshot: AntigravityRuntimeViewInput = {
    state: { revision: 1, inspection, operation: null },
    error: null,
    pending: null,
  };
  const listeners = new Set<() => void>();
  const run = vi.fn(async () => {});
  const owner: AntigravityRuntimeOwner = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    run,
  };
  const view = render(
    <>
      <AntigravityRuntimeRow owner={owner} profileCount={1} />
      <AntigravityProfileExecutable profileId={profileId} owner={owner} />
    </>,
  );
  expect(view.getAllByText("Downloaded runtime · 1.5.13")).toHaveLength(2);
  expect(run).toHaveBeenCalledExactlyOnceWith("check");
  run.mockClear();
  fireEvent.click(view.getByRole("button", { name: "Check for updates" }));
  expect(run).toHaveBeenLastCalledWith("install");

  await act(async () => {
    snapshot = {
      ...snapshot,
      state: { revision: 2, inspection, operation: antigravityOperation() },
    };
    listeners.forEach((listener) => listener());
  });
  fireEvent.click(view.getByRole("button", { name: "Cancel" }));
  expect(run).toHaveBeenLastCalledWith("cancel");
  expect(view.queryByRole("button", { name: "Remove" })).toBeNull();

  await act(async () => {
    snapshot = { ...snapshot, state: { revision: 3, inspection, operation: null } };
    listeners.forEach((listener) => listener());
  });
  fireEvent.click(view.getByRole("button", { name: "Remove" }));
  expect(
    view.getByText("Remove the downloaded Antigravity runtime? Sign-ins and chats are kept."),
  ).toBeTruthy();
  expect(run).toHaveBeenCalledTimes(2);
  fireEvent.click(view.getByRole("button", { name: "Keep" }));
  fireEvent.click(view.getByRole("button", { name: "Remove" }));
  fireEvent.click(view.getByRole("button", { name: "Remove" }));
  expect(run).toHaveBeenLastCalledWith("remove");
});
