import { act, render } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { TestQueryProvider } from "@/test/query";
import { installWindowApi } from "@/test/browser-globals";
import { useAutomationsQuery } from "@/lib/use-automations-query";
import { useAutomationRunsInbox } from "@/lib/use-automation-runs";
import { WorkbenchAppRail } from "@/components/workbench/workbench-app-rail";
import {
  DEFAULT_AUTOMATION_SOURCE_FILTER,
  AutomationEventFields,
  AutomationSourceFields,
} from "./automation-event-fields";

vi.mock("@/lib/renderer-space", async (original) => ({
  ...(await original<typeof import("@/lib/renderer-space")>()),
  isRemoteSpace: () => true,
}));

test("team navigation hides Automations and does not acquire personal Automation reads or streams", async () => {
  const invoke = vi.fn();
  const subscribe = vi.fn(() => () => {});
  installWindowApi({ invoke, on: subscribe });
  function TeamRail() {
    useAutomationsQuery();
    useAutomationRunsInbox();
    return (
      <WorkbenchAppRail
        contentOnly
        destination="home"
        onHome={vi.fn()}
        onSpace={vi.fn()}
        onAutomations={vi.fn()}
        onInsights={vi.fn()}
        onPlugins={vi.fn()}
      />
    );
  }
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <TestQueryProvider>
        <TeamRail />
      </TestQueryProvider>,
    );
    await Promise.resolve();
  });
  expect(view.getByRole("button", { name: "Home" })).toBeTruthy();
  expect(view.getByRole("button", { name: "Space" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Automations" })).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
  expect(subscribe).not.toHaveBeenCalled();
});

test.each([
  ["Source picker", AutomationSourceFields],
  ["event editor", AutomationEventFields],
] as const)("team %s stays host-only without reading Sources", async (_, Fields) => {
  const invoke = vi.fn();
  installWindowApi({ invoke });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <TestQueryProvider>
        <Fields value={DEFAULT_AUTOMATION_SOURCE_FILTER} disabled={false} onChange={vi.fn()} />
      </TestQueryProvider>,
    );
    await Promise.resolve();
  });
  expect(view.getByRole("status").textContent).toBe(
    "Event Automations for this Space run on its host",
  );
  expect(view.queryByRole("button", { name: "Source" })).toBeNull();
  expect(view.queryByRole("group", { name: "Event kinds" })).toBeNull();
  expect(view.queryByRole("textbox", { name: "Repositories" })).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});
