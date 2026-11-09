import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { SpaceConnectionSummary } from "../../../shared/space-connection";
import { useSpaceSwitchCommands } from "./space-switching";

const runtime = vi.hoisted(() => {
  const space = (
    spaceId: string,
    kind: SpaceConnectionSummary["kind"],
    name: string,
  ): SpaceConnectionSummary => ({
    spaceId,
    kind,
    name,
    memberId: null,
    deviceId: null,
    availability: "ready",
  });
  return {
    switch: vi.fn<(spaceId: string) => Promise<void>>(),
    spaces: [
      space("personal", "personal", "Personal"),
      { ...space("crew", "team", "Final Crew"), availability: "reconnecting" },
      space("lab", "team", "Lab"),
    ] satisfies readonly SpaceConnectionSummary[],
  };
});
vi.mock("./spaces-runtime", () => ({
  useSpaces: () => ({ spaces: runtime.spaces, current: runtime.spaces[1] }),
  switchSpace: runtime.switch,
}));
beforeEach(() => {
  runtime.switch.mockReset().mockResolvedValue(undefined);
});

test("the command palette opens every Space but this window's own", async () => {
  const { result } = renderHook(() => useSpaceSwitchCommands());
  expect(result.current.commands.map(({ title, group }) => [title, group])).toEqual([
    ["Switch to Personal", "Navigation"],
    ["Switch to Lab", "Navigation"],
  ]);
  const lab = result.current.commands[1]!;
  expect(result.current.execute(lab.id)).toBe(true);
  await waitFor(() => expect(runtime.switch).toHaveBeenCalledWith("lab"));
  expect(result.current.execute("settings")).toBe(false);
  expect(runtime.switch).toHaveBeenCalledOnce();
});
