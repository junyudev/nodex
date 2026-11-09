import { queryOptions, useQuery } from "@tanstack/react-query";
import { readLibraryModule } from "./api";
import { rendererSpace, spaceQueryKey } from "./renderer-space";

export const membersQueryOptions = () =>
  queryOptions({
    queryKey: spaceQueryKey(["library", "members"]),
    staleTime: Infinity,
    queryFn: async () => {
      const result = await readLibraryModule({ kind: "library" }, { read: { mode: "members" } });
      if (!result.ok) throw new Error(result.error.message);
      if (result.value.value.kind !== "members")
        throw new Error("Library returned a non-Members read");
      return result.value.value.items;
    },
  });
export const useMembers = () => useQuery(membersQueryOptions());

export const useLocalMember = () =>
  useQuery({
    queryKey: spaceQueryKey(["library", "localMember"]),
    staleTime: Infinity,
    queryFn: async () => {
      const space = rendererSpace();
      if (space.kind === "team") {
        const members = await readLibraryModule({ kind: "library" }, { read: { mode: "members" } });
        if (!members.ok || members.value.value.kind !== "members")
          throw new Error("Space Members are unavailable");
        const member = members.value.value.items.find(
          (candidate) => candidate.id === space.memberId,
        );
        if (!member) throw new Error("Access revoked");
        return member;
      }
      const result = await readLibraryModule(
        { kind: "library" },
        { read: { mode: "local_member" } },
      );
      if (!result.ok) throw new Error(result.error.message);
      if (result.value.value.kind !== "local_member") throw new Error("Invalid local Member");
      return result.value.value.value;
    },
  });
