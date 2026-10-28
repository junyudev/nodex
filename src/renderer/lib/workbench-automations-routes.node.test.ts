import { describe, expect, test } from "vite-plus/test";
import { buildAutomationsPath, resolveAutomationsRouteState } from "./workbench-automations-routes";

describe("workbench automations routes", () => {
  test("builds the Scheduled root without redundant params", () => {
    expect(buildAutomationsPath()).toBe("/automations");
    expect(buildAutomationsPath({ automationId: "  ", runSessionId: "" })).toBe("/automations");
  });

  test("round trips task selection, dialog mode, and a presented run chat", () => {
    const path = buildAutomationsPath({
      automationId: "automation-1",
      automationMode: "edit",
    });
    expect(path).toBe("/automations?automationId=automation-1&automationMode=edit");
    expect(resolveAutomationsRouteState(path)).toEqual({
      automationId: "automation-1",
      automationMode: "edit",
      templateId: null,
      runbookPageId: null,
      runbookTitle: null,
      projectId: null,
      runSessionId: null,
    });
    expect(
      resolveAutomationsRouteState("/automations?automationId=a&runSessionId=session-1"),
    ).toEqual({
      automationId: "a",
      automationMode: null,
      templateId: null,
      runbookPageId: null,
      runbookTitle: null,
      projectId: null,
      runSessionId: "session-1",
    });
  });

  test("editing requires a task while creating does not", () => {
    expect(buildAutomationsPath({ automationMode: "edit" })).toBe("/automations");
    expect(buildAutomationsPath({ automationMode: "create" })).toBe(
      "/automations?automationMode=create",
    );
    expect(resolveAutomationsRouteState("/automations?automationMode=edit").automationMode).toBe(
      null,
    );
  });

  test("only a new task starts from a template", () => {
    const path = buildAutomationsPath({ automationMode: "create", templateId: "daily-bug-scan" });
    expect(path).toBe("/automations?automationMode=create&templateId=daily-bug-scan");
    expect(resolveAutomationsRouteState(path).templateId).toBe("daily-bug-scan");
    expect(buildAutomationsPath({ automationId: "a", templateId: "daily-bug-scan" })).toBe(
      "/automations?automationId=a",
    );
    expect(
      resolveAutomationsRouteState("/automations?automationId=a&templateId=daily-bug-scan")
        .templateId,
    ).toBe(null);
  });

  test("only a new task follows a runbook Page from the route", () => {
    const path = buildAutomationsPath({
      automationMode: "create",
      runbookPageId: "page-1",
      runbookTitle: "Dependency policy",
      projectId: "project-1",
    });
    expect(path).toBe(
      "/automations?automationMode=create&runbookPageId=page-1&runbookTitle=Dependency+policy&projectId=project-1",
    );
    expect(resolveAutomationsRouteState(path)).toMatchObject({
      runbookPageId: "page-1",
      runbookTitle: "Dependency policy",
      projectId: "project-1",
    });
    expect(buildAutomationsPath({ automationId: "a", runbookPageId: "page-1" })).toBe(
      "/automations?automationId=a",
    );
  });
});
