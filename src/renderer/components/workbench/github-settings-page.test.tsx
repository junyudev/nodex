import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";
import { GitHubSettingsView } from "./github-settings-page";
import type { SourcesSettingsSnapshot } from "../../../shared/sources";
const source: NonNullable<SourcesSettingsSnapshot["source"]> = {
  id: "source",
  kind: "github",
  library_id: "library",
  revision: 2,
  enabled: true,
  enabled_at_ms: 1,
  config: {
    host: "github.com",
    account_id: "1",
    account_login: "alice",
    credential_ref: "gh:github.com:alice",
    repositories: [{ id: "10", name: "alice/repo", enabled: true }],
    discovery: { assigned: true, review_requests: true, mentions: true },
  },
};
const snapshot: SourcesSettingsSnapshot = {
  source,
  account: { login: "alice", id: "1" },
  connection: "connected",
  repositories: source.config.repositories,
  problems: [],
  lastSuccessAtMs: 2,
  nextPollAtMs: 60000,
};
afterEach(cleanup);
describe("GitHub settings", () => {
  it("shows a verified CLI account before the person enables watching", async () => {
    const connect = vi.fn();
    render(
      <GitHubSettingsView
        snapshot={{ ...snapshot, source: null }}
        pending={false}
        error={null}
        onConnect={connect}
        onUpdate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Connected as alice")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
      await Promise.resolve();
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(screen.queryByRole("switch", { name: "Watch GitHub" })).toBeNull();
  });

  it("saves repository and discovery choices with the observed configuration revision", async () => {
    const update = vi.fn();
    render(
      <GitHubSettingsView
        snapshot={snapshot}
        pending={false}
        error={null}
        onConnect={vi.fn()}
        onUpdate={update}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Connected as alice")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("switch", { name: "Watch alice/repo" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: "source",
          expectedRevision: 2,
          repositories: [{ id: "10", enabled: false }],
        }),
      ),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Mentions" }));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          discovery: { assigned: true, review_requests: true, mentions: false },
        }),
      ),
    );
  });
  it("offers reconnect and retries the Source problem without hiding saved choices", async () => {
    const connect = vi.fn();
    const retry = vi.fn();
    render(
      <GitHubSettingsView
        snapshot={{
          ...snapshot,
          connection: "reconnect",
          problems: [
            {
              id: "problem",
              source_id: "source",
              scope: "repo:10",
              kind: "credential_invalid",
              library_id: "library",
              summary: "Reconnect GitHub",
              fix: "reconnect",
              first_failure_at_ms: 1,
              last_failure_at_ms: 3,
              consecutive_failures: 3,
              evidence: { reason: "credential" },
            },
          ],
        }}
        pending={false}
        error={null}
        onConnect={connect}
        onUpdate={vi.fn()}
        onRetry={retry}
      />,
    );
    expect(
      screen.getByRole("switch", { name: "Watch alice/repo" }).getAttribute("aria-checked"),
    ).toBe("true");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(connect).toHaveBeenCalledOnce();
      expect(retry).toHaveBeenCalledWith("source");
    });
  });
  it("disables changes while a save is pending and exposes errors", () => {
    render(
      <GitHubSettingsView
        snapshot={snapshot}
        pending
        error="Settings changed. Reload."
        onConnect={vi.fn()}
        onUpdate={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "Assigned to me" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(screen.getByRole("alert").textContent).toBe("Settings changed. Reload.");
  });
});
