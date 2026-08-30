import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { GlobalDictationRendererCommand } from "../../../shared/global-dictation";
import {
  InAppDictationRouter,
  useInAppDictationTarget,
  type InAppDictationTarget,
} from "./in-app-dictation-router";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("./dictation-command-runtime", () => ({
  reportGlobalDictationEvent: (event: unknown) => mocks.invoke("global-dictation:event", event),
}));

const SESSION_ID = "00000000-0000-4000-8000-000000000001";
const REQUEST_ID = "00000000-0000-4000-8000-000000000002";

function RegisteredTarget({ target }: { readonly target: InAppDictationTarget }) {
  useInAppDictationTarget(target);
  return null;
}

describe("InAppDictationRouter", () => {
  let dispatch: ((command: GlobalDictationRendererCommand) => void) | null = null;

  beforeEach(() => {
    dispatch = null;
    mocks.invoke.mockReset().mockResolvedValue(true);
    window.api = {
      on: vi.fn((_channel: string, listener: (value: unknown) => void) => {
        dispatch = listener as (command: GlobalDictationRendererCommand) => void;
        return () => {
          dispatch = null;
        };
      }),
    } as unknown as typeof window.api;
  });

  test("admits the highest-priority eligible target and routes terminal commands only to it", async () => {
    const hidden = {
      id: "composer:hidden",
      priority: 30,
      admission: () => "hidden" as const,
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      cancel: vi.fn(),
    };
    const focused = {
      id: "composer:focused",
      priority: 20,
      admission: () => null,
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      cancel: vi.fn(),
    };
    render(
      <InAppDictationRouter>
        <RegisteredTarget target={hidden} />
        <RegisteredTarget target={focused} />
      </InAppDictationRouter>,
    );

    await act(async () => {
      dispatch?.({
        type: "start",
        sessionId: SESSION_ID,
        requestId: REQUEST_ID,
        deadlineAtMs: Date.now() + 1_000,
        gesture: "hold",
      });
    });
    await waitFor(() => expect(focused.start).toHaveBeenCalledOnce());
    expect(hidden.start).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("global-dictation:event", {
      type: "accepted",
      sessionId: SESSION_ID,
      requestId: REQUEST_ID,
      targetId: "composer:focused",
    });

    act(() => dispatch?.({ type: "stop", sessionId: SESSION_ID }));
    expect(focused.stop).toHaveBeenCalledOnce();
    expect(hidden.stop).not.toHaveBeenCalled();
  });

  test("declines immediately when every mounted composer is ineligible", async () => {
    const target = {
      id: "composer:collapsed",
      priority: 20,
      admission: () => "hidden" as const,
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      cancel: vi.fn(),
    };
    render(
      <InAppDictationRouter>
        <RegisteredTarget target={target} />
      </InAppDictationRouter>,
    );

    act(() =>
      dispatch?.({
        type: "start",
        sessionId: SESSION_ID,
        requestId: REQUEST_ID,
        deadlineAtMs: Date.now() + 1_000,
        gesture: "toggle",
      }),
    );

    await waitFor(() =>
      expect(mocks.invoke).toHaveBeenCalledWith("global-dictation:event", {
        type: "declined",
        sessionId: SESSION_ID,
        requestId: REQUEST_ID,
        reason: "hidden",
      }),
    );
    expect(target.start).not.toHaveBeenCalled();
  });
});
