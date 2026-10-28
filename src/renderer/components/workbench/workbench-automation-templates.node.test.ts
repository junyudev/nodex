import { describe, expect, test } from "vite-plus/test";
import {
  WORKBENCH_AUTOMATION_TEMPLATES,
  createWorkbenchAutomationDraftFromTemplate,
} from "./workbench-automation-templates";

describe("workbench automation templates", () => {
  test("creates a manual draft from a selected template", () => {
    const template = WORKBENCH_AUTOMATION_TEMPLATES[0];
    if (!template) throw new Error("Expected a template");

    const draft = createWorkbenchAutomationDraftFromTemplate(template);

    expect(draft.kind).toBe("cron");
    expect(draft.executionEnvironment).toBe("local");
    expect(draft.projectId).toBeNull();
    expect(draft.name).toBe("Daily bug scan");
    expect(draft.prompt.includes("Scan recent commits")).toBe(true);
    expect(draft.rrule).toBe("FREQ=DAILY;BYHOUR=9;BYMINUTE=0");
    expect(draft.cwds.length).toBe(0);
  });

  test("work that changes the repository asks in the Inbox first; reports run on their own", () => {
    const launchOf = (id: string) => {
      const template = WORKBENCH_AUTOMATION_TEMPLATES.find((candidate) => candidate.id === id);
      if (!template) throw new Error(`Expected template ${id}`);
      return createWorkbenchAutomationDraftFromTemplate(template).launch;
    };
    expect(launchOf("bump-dependency-versions")).toBe("ask");
    expect(launchOf("security-check")).toBe("automatic");
    expect(launchOf("daily-bug-scan")).toBe("automatic");
  });
});
