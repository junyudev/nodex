import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import type { Member } from "../../shared/work-graph";
import { memberIdentity, type SpaceDirectoryMember } from "./member-identity";
import { invalidateExactQuery } from "./query-invalidation";
import { invokeRendererQuery } from "./renderer-command";
import { rendererSpaceId, spaceQueryKey } from "./renderer-space";
import { resolveRendererTransport } from "./renderer-transport";

const readMemberProjection = async (mode: "members" | "local_member") => {
  const result = await invokeRendererQuery(
    "library-module:read",
    { kind: "library" },
    { read: { mode } },
  );
  if (!result.ok) throw new Error(result.error.message);
  return result.value.value;
};

export const membersQueryOptions = () =>
  queryOptions({
    queryKey: spaceQueryKey(["library", "members"]),
    staleTime: Infinity,
    queryFn: async () => {
      const value = await readMemberProjection("members");
      if (value.kind !== "members") throw new Error("Library returned a non-Members read");
      return value.items;
    },
  });

const localMemberQueryOptions = () =>
  queryOptions({
    queryKey: spaceQueryKey(["library", "localMember"]),
    staleTime: Infinity,
    queryFn: async () => {
      const value = await readMemberProjection("local_member");
      if (value.kind !== "local_member") throw new Error("Invalid local Member");
      return value.value;
    },
  });

export const useMembers = () => useQuery(membersQueryOptions());
export const useLocalMember = () => useQuery(localMemberQueryOptions());

const directoryMembers = (
  members: readonly Member[],
): readonly Omit<SpaceDirectoryMember, "isCurrentMember">[] =>
  members.map((member) => {
    const { name, initials, color } = memberIdentity(member);
    return {
      id: member.id,
      displayName: name,
      initials,
      color,
      role: member.role,
      lifecycle: member.lifecycle,
    };
  });

const selectMemberId = (member: Member) => member.id;

/** Includes retained Member identities so mentions can still resolve after removal. */
export function useMemberDirectory(): {
  readonly data: readonly SpaceDirectoryMember[] | undefined;
  readonly isPending: boolean;
  readonly error: Error | null;
} {
  const members = useQuery({ ...membersQueryOptions(), select: directoryMembers });
  const current = useQuery({ ...localMemberQueryOptions(), select: selectMemberId });
  const { data } = members;
  const currentMemberId = current.data;
  return {
    data:
      data && currentMemberId
        ? data.map((member): SpaceDirectoryMember => ({
            ...member,
            isCurrentMember: member.id === currentMemberId,
          }))
        : undefined,
    isPending: members.isPending || current.isPending,
    error: members.error ?? current.error,
  };
}

/** Called once per renderer query cache to follow committed changes in the bound Space. */
export function followMemberDirectory(client: QueryClient): (() => void) | undefined {
  return resolveRendererTransport().subscribeMembersChanged?.((spaceId) => {
    if (spaceId !== rendererSpaceId()) return;
    void invalidateExactQuery(client, membersQueryOptions().queryKey);
    void invalidateExactQuery(client, localMemberQueryOptions().queryKey);
  });
}
