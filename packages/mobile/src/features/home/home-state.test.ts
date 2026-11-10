import { beforeEach, describe, expect, it } from "vitest";

import { useHomeState } from "./home-state";

const state = () => useHomeState.getState();

describe("the Inbox a Space shows", () => {
  beforeEach(() => useHomeState.setState({ scopes: {}, filter: "inbox", replyTo: null }));

  it("is chosen for one Space without changing another's", () => {
    state().setScope("space-a", { kind: "project", projectId: "p1" });
    expect(state().scopes).toEqual({ "space-a": { kind: "project", projectId: "p1" } });
    state().setScope("space-b", { kind: "all" });
    expect(state().scopes["space-a"]).toEqual({ kind: "project", projectId: "p1" });
  });

  it("opens on what waits there, and ends a reply to a message of the last one", () => {
    useHomeState.setState({
      filter: "processed",
      replyTo: { spaceKey: "space-a", entryId: "e1", episode: "1", title: "A question" },
    });
    state().setScope("space-a", { kind: "project", projectId: "p1" });
    expect(state().filter).toBe("inbox");
    expect(state().replyTo).toBeNull();
  });

  it("is forgotten with its Space", () => {
    state().setScope("space-a", { kind: "project", projectId: "p1" });
    state().setScope("space-b", { kind: "project", projectId: "p2" });
    state().forgetSpace("space-a");
    expect(state().scopes).toEqual({ "space-b": { kind: "project", projectId: "p2" } });
  });
});

describe("enterSpace", () => {
  beforeEach(() => useHomeState.setState({ space: "space-a" }));

  it("drops the search and filters that narrowed the last Space's lists", () => {
    useHomeState.setState({ filter: "processed", search: "export", chatsArchived: true });
    state().enterSpace("space-b");
    expect(state()).toMatchObject({ filter: "inbox", search: null, chatsArchived: false });
  });

  it("keeps them while the Space stays the same", () => {
    useHomeState.setState({ filter: "processed", search: "export", chatsArchived: true });
    state().enterSpace("space-a");
    expect(state()).toMatchObject({ filter: "processed", search: "export", chatsArchived: true });
  });
});
