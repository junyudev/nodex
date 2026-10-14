import { act, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { NodexSettingsSection } from "@/components/ui/settings";
import {
  applyRendererThemeForTest,
  installRendererThemeFixture,
  readRendererThemeColor,
} from "@/test/renderer-theme";
import type {
  CodexRequestLifecycleEvent,
  CodexRequestLifecycleTerminalEvent,
} from "../../../shared/codex-request-lifecycle";
import { CodexRequestDiagnostics } from "./codex-request-diagnostics";
import { clearCodexRequestRecords, CodexRequestRecorder } from "./codex-request-recorder";
import "@/globals.css";

installRendererThemeFixture();

const hostIds = new Set<string>();
let hostSequence = 0;

afterEach(async () => {
  await act(async () => {
    for (const hostId of hostIds) clearCodexRequestRecords(hostId);
    hostIds.clear();
    await Promise.resolve();
  });
});

function recorderForHost() {
  const hostId = `diagnostics-host-${++hostSequence}`;
  hostIds.add(hostId);
  return { hostId, recorder: new CodexRequestRecorder(hostId) };
}

function started(
  hostId: string,
  id: string,
  method: string,
  startedAtMs: number,
): Extract<CodexRequestLifecycleEvent, { type: "started" }> {
  return {
    type: "started",
    hostId,
    id,
    method,
    params: { threadId: "fixture-chat" },
    conversationId: "fixture-chat",
    priority: "interactive",
    source: "settings",
    queueWaitMs: 3,
    startedAtMs,
    timeoutMs: 1_000,
  };
}

function finished(
  request: Extract<CodexRequestLifecycleEvent, { type: "started" }>,
  status: "completed" | "failed",
): CodexRequestLifecycleTerminalEvent {
  const timing = {
    hostId: request.hostId,
    id: request.id,
    method: request.method,
    priority: request.priority,
    source: request.source,
    timeoutMs: request.timeoutMs,
    durationMs: 40,
    queueWaitMs: request.queueWaitMs,
    requestDurationMs: 37,
    queuedRequestCountAtEnqueue: 0,
    peakInFlightRequestCount: 1,
    peakBackgroundInFlightRequestCount: 0,
    coalescedRequestCount: 0,
    endedAtMs: request.startedAtMs + 40,
  };
  if (status === "failed") return { ...timing, type: status, error: { message: "Host offline" } };
  return { ...timing, type: status, result: { title: "Fixture chat" } };
}

function DiagnosticsSettings({ enabled = true }: { enabled?: boolean }) {
  return (
    <NodexSettingsSection title="Diagnostics">
      <CodexRequestDiagnostics enabled={enabled} />
    </NodexSettingsSection>
  );
}

function outlinedAncestors(element: Element, boundary: Element): Element[] {
  const outlines: Element[] = [];
  for (
    let current: Element | null = element;
    current && current !== boundary;
    current = current.parentElement
  ) {
    const style = getComputedStyle(current);
    if (
      [
        style.borderTopWidth,
        style.borderRightWidth,
        style.borderBottomWidth,
        style.borderLeftWidth,
      ].every((width) => Number.parseFloat(width) > 0)
    )
      outlines.push(current);
  }
  return outlines;
}

function expectThemedDivider(element: Element): void {
  const style = getComputedStyle(element);
  const top = Number.parseFloat(style.borderTopWidth) > 0;
  expect(top || Number.parseFloat(style.borderBottomWidth) > 0).toBe(true);
  expect(top ? style.borderTopColor : style.borderBottomColor).toBe(
    readRendererThemeColor("--color-border"),
  );
}

describe("App server request diagnostics in settings", () => {
  test.each(["light", "dark"] as const)(
    "paints the shared section, request dividers, and text with the active %s palette",
    async (variant) => {
      applyRendererThemeForTest(variant);
      const { hostId, recorder } = recorderForHost();
      const second = recorderForHost();
      const view = render(<DiagnosticsSettings />);
      const trigger = view.getByRole("button", { name: "App server requests" });
      const section = view.getByRole("region", { name: "Diagnostics" });
      const outlines = outlinedAncestors(trigger, section);
      expect(outlines).toHaveLength(1);
      const surface = outlines[0]!;
      expect(getComputedStyle(surface).borderTopColor).toBe(
        readRendererThemeColor("--color-token-border"),
      );
      expect(getComputedStyle(view.getByText("App server requests")).color).toBe(
        readRendererThemeColor("--color-text"),
      );

      await act(async () => {
        await userEvent.click(trigger);
      });
      await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
      const request = started(hostId, "paint", "thread/read", 100);
      const failure = started(hostId, "paint-failure", "thread/resume", 200);
      const otherHost = started(second.hostId, "other-host", "model/list", 50);
      await act(async () => {
        recorder.handle(request);
        recorder.handle(finished(request, "completed"));
        recorder.handle(failure);
        recorder.handle(finished(failure, "failed"));
        second.recorder.handle(otherHost);
        await Promise.resolve();
      });
      const method = await view.findByText("thread/read");
      const host = view.getByText(hostId);
      expect(outlinedAncestors(host, section)).toEqual([surface]);
      expect(outlinedAncestors(method, section)).toEqual([surface]);
      expect(getComputedStyle(host).color).toBe(readRendererThemeColor("--color-text"));
      expect(getComputedStyle(method).color).toBe(readRendererThemeColor("--color-text"));
      const hostGroup = view.getByRole("region", { name: `Requests for ${hostId}` });
      expect(getComputedStyle(within(hostGroup).getByText("2 requests")).color).toBe(
        readRendererThemeColor("--color-text-secondary"),
      );
      expect(getComputedStyle(view.getByText("Failed · 40 ms")).color).toBe(
        readRendererThemeColor("--color-text-danger"),
      );
      expect(getComputedStyle(within(hostGroup).getAllByText("#1")[0]!).color).toBe(
        readRendererThemeColor("--color-text-tertiary"),
      );
      const panelId = trigger.getAttribute("aria-controls");
      const panel = panelId ? document.getElementById(panelId) : null;
      if (!panel) throw new Error("Diagnostics disclosure panel is missing");
      expectThemedDivider(panel);
      expectThemedDivider(view.getByRole("region", { name: `Requests for ${second.hostId}` }));
      const requestDetails = method.closest("details");
      if (!requestDetails) throw new Error("Recorded request details are missing");
      expectThemedDivider(requestDetails);

      const requestTrigger = method.closest("summary");
      if (!requestTrigger) throw new Error("Request disclosure is missing");
      await act(async () => {
        await userEvent.click(requestTrigger);
      });
      const details = requestTrigger.closest("details");
      const detailsBody = requestTrigger.nextElementSibling;
      if (!details || !detailsBody) throw new Error("Request payload details are missing");
      expectThemedDivider(detailsBody);
      const payloads = details.querySelectorAll("pre");
      expect(payloads).toHaveLength(2);
      for (const payload of payloads) {
        const style = getComputedStyle(payload);
        expect(payload.getBoundingClientRect().height).toBeGreaterThan(0);
        expect(style.color).toBe(readRendererThemeColor("--color-text"));
        expect(style.backgroundColor).toBe(
          readRendererThemeColor("--color-background-primary-soft"),
        );
      }
    },
  );

  test("opens from the keyboard, captures real request lifecycles, filters failures, and clears one host", async () => {
    const first = recorderForHost();
    const second = recorderForHost();
    const view = render(<DiagnosticsSettings />);
    const trigger = view.getByRole("button", { name: "App server requests" });
    await act(async () => {
      first.recorder.handle(started(first.hostId, "hidden", "hidden/read", 50));
      await Promise.resolve();
    });
    expect(first.recorder.getEntries()).toHaveLength(0);

    await act(async () => {
      await userEvent.keyboard("{Tab}{Enter}");
    });
    expect(document.activeElement).toBe(trigger);
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
    const success = started(first.hostId, "success", "thread/read", 100);
    const failure = started(first.hostId, "failure", "thread/resume", 200);
    const otherHost = started(second.hostId, "other", "model/list", 300);
    await act(async () => {
      for (const [recorder, request, status] of [
        [first.recorder, success, "completed"],
        [first.recorder, failure, "failed"],
        [second.recorder, otherHost, "completed"],
      ] as const) {
        recorder.handle(request);
        recorder.handle(finished(request, status));
      }
      await Promise.resolve();
    });
    const method = await view.findByText("thread/read");
    const requestTrigger = method.closest("summary, button");
    if (!requestTrigger) throw new Error("Request disclosure is missing");
    const requestDetails = requestTrigger.closest("details");
    if (!requestDetails) throw new Error("Request details are missing");
    await act(async () => {
      await userEvent.click(requestTrigger);
    });
    expect(
      within(requestDetails)
        .getByText(JSON.stringify({ threadId: "fixture-chat" }, null, 2), {
          normalizer: (value) => value.trim(),
        })
        .getBoundingClientRect().height,
    ).toBeGreaterThan(0);
    expect(
      within(requestDetails)
        .getByText(JSON.stringify({ title: "Fixture chat" }, null, 2), {
          normalizer: (value) => value.trim(),
        })
        .getBoundingClientRect().height,
    ).toBeGreaterThan(0);

    const firstHost = view.getByText(first.hostId).closest("section");
    if (!firstHost) throw new Error("Host request group is missing");
    await act(async () => {
      await userEvent.click(within(firstHost).getByRole("checkbox", { name: /^Failed/ }));
    });
    await waitFor(() => expect(view.queryByText("thread/read")).toBeNull());
    expect(view.getByText("thread/resume")).toBeTruthy();
    expect(view.getByText("model/list")).toBeTruthy();

    await act(async () => {
      await userEvent.click(within(firstHost).getByRole("button", { name: "Clear" }));
    });
    await waitFor(() => expect(view.queryByText(first.hostId)).toBeNull());
    expect(first.recorder.getEntries()).toHaveLength(0);
    expect(second.recorder.getEntries()).toHaveLength(1);
    expect(view.getByText("model/list")).toBeTruthy();
  });

  test("releases capture while collapsed, disabled, and unmounted, then resumes when enabled", async () => {
    const { hostId, recorder } = recorderForHost();
    const view = render(<DiagnosticsSettings enabled={false} />);
    const trigger = view.getByRole("button", { name: "App server requests" });
    await act(async () => {
      await userEvent.keyboard("{Tab}{Enter}");
    });
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
    await act(async () => {
      recorder.handle(started(hostId, "disabled", "disabled/read", 50));
      await Promise.resolve();
    });
    expect(recorder.getEntries()).toHaveLength(0);

    view.rerender(<DiagnosticsSettings />);
    await act(async () => {
      recorder.handle(started(hostId, "enabled", "thread/read", 100));
      await Promise.resolve();
    });
    await view.findByText("thread/read");
    await act(async () => {
      trigger.focus();
      await userEvent.keyboard("{Space}");
    });
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("false"));
    await act(async () => {
      recorder.handle(started(hostId, "collapsed", "collapsed/read", 200));
      await Promise.resolve();
    });
    expect(recorder.getEntries().map((request) => request.id)).toEqual(["enabled"]);

    await act(async () => {
      await userEvent.keyboard("{Enter}");
    });
    await waitFor(() => expect(trigger.getAttribute("aria-expanded")).toBe("true"));
    view.rerender(<DiagnosticsSettings enabled={false} />);
    await act(async () => {
      recorder.handle(started(hostId, "disabled-again", "disabled/read", 300));
      await Promise.resolve();
    });
    expect(recorder.getEntries().map((request) => request.id)).toEqual(["enabled"]);
    view.rerender(<DiagnosticsSettings />);
    await act(async () => {
      recorder.handle(started(hostId, "resumed", "thread/resume", 400));
      await Promise.resolve();
    });
    await view.findByText("thread/resume");
    view.unmount();
    await act(async () => {
      recorder.handle(started(hostId, "unmounted", "unmounted/read", 500));
      await Promise.resolve();
    });
    expect(recorder.getEntries().map((request) => request.id)).toEqual(["resumed", "enabled"]);
  });
});
