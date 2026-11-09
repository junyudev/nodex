import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { SpaceConnectionSummary } from "../../../shared/space-connection";
import { bindRendererSpace } from "@/lib/renderer-space";
import { followSpaceConnections } from "./spaces-runtime";

const runtime = vi.hoisted(() => ({
  listeners: new Set<(spaces: readonly SpaceConnectionSummary[]) => void>(),
  listed: [] as readonly SpaceConnectionSummary[],
}));
vi.mock("@/lib/renderer-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/renderer-command")>()),
  invokeRendererQuery: async (channel: string) => {
    if (channel !== "spaces:list") throw new Error(`Unexpected ${channel}`);
    return runtime.listed;
  },
}));
vi.mock("@/lib/renderer-transport", () => ({
  resolveRendererTransport: () => ({
    subscribeSpaceConnections: (listener: (spaces: readonly SpaceConnectionSummary[]) => void) => {
      runtime.listeners.add(listener);
      return () => runtime.listeners.delete(listener);
    },
  }),
}));

const team = (availability: SpaceConnectionSummary["availability"]): SpaceConnectionSummary => ({
  spaceId: "team",
  kind: "team",
  name: "Crew",
  memberId: "member",
  deviceId: "device",
  availability,
});
const personal: SpaceConnectionSummary = {
  ...team("ready"),
  spaceId: "personal",
  kind: "personal",
};
const push = (availability: SpaceConnectionSummary["availability"]) => {
  for (const listener of runtime.listeners) listener([personal, team(availability)]);
};

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  runtime.listed = [personal, team("reconnecting")];
  bindRendererSpace(team("reconnecting"));
});
afterEach(() => client.clear());

test("a team desktop opened while its host is down reads its Space again once the host is ready", async () => {
  let hostUp = false;
  const reads = vi.fn(async () => {
    if (!hostUp) throw new Error("connect ECONNREFUSED");
    return ["Phase5 Project"];
  });
  const projects = new QueryObserver(client, { queryKey: ["projects"], queryFn: reads });
  const stopReading = projects.subscribe(() => {});
  const stopFollowing = followSpaceConnections(client);
  try {
    await vi.waitFor(() => expect(projects.getCurrentResult().status).toBe("error"));
    // Another Space changing, or this one still reconnecting, is not a return.
    push("reconnecting");
    await Promise.resolve();
    expect(reads).toHaveBeenCalledOnce();

    hostUp = true;
    push("ready");
    await vi.waitFor(() => expect(projects.getCurrentResult().data).toEqual(["Phase5 Project"]));
    push("ready");
    await Promise.resolve();
    expect(reads).toHaveBeenCalledTimes(2);

    // A read that succeeded may have missed changes while the host was away.
    push("reconnecting");
    push("ready");
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(3));
  } finally {
    stopFollowing();
    stopReading();
  }
});

test("a Space already ready when its document starts is not read twice", async () => {
  runtime.listed = [personal, team("ready")];
  bindRendererSpace(team("ready"));
  const reads = vi.fn(async () => ["Phase5 Project"]);
  const projects = new QueryObserver(client, { queryKey: ["projects"], queryFn: reads });
  const stopReading = projects.subscribe(() => {});
  const stopFollowing = followSpaceConnections(client);
  try {
    await vi.waitFor(() =>
      expect(client.getQueryData(["desktop", "space-connections"])).toEqual(runtime.listed),
    );
    push("ready");
    await vi.waitFor(() => expect(projects.getCurrentResult().status).toBe("success"));
    expect(reads).toHaveBeenCalledOnce();
  } finally {
    stopFollowing();
    stopReading();
  }
});
