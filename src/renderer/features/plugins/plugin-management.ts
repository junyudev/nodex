import type { InfiniteData, UseInfiniteQueryResult, UseQueryResult } from "@tanstack/react-query";
import type {
  PluginContext,
  PluginManagementCapabilities,
  PublicPluginSections,
  PluginPage,
  PersonalPlugins,
  PersonalPluginPage,
  PluginCategoryMetadata,
  PluginRow,
  PluginSelector,
  PluginDetailView,
  SkillsView,
  SkillContentsSelector,
  PluginCommands,
} from "../../../shared/codex-plugin-management";
export type * from "../../../shared/codex-plugin-management";
export type PluginRowsQuery = UseQueryResult<readonly PluginRow[], Error>;
export type PluginInfiniteQuery = UseInfiniteQueryResult<InfiniteData<PluginPage>, Error> & {
  readonly rows: readonly PluginRow[];
  readonly category: PluginCategoryMetadata | undefined;
};
export type PersonalInfiniteQuery = UseInfiniteQueryResult<
  InfiniteData<PersonalPluginPage>,
  Error
> & { readonly rows: readonly PluginRow[] };
export type PluginManagement = {
  readonly [K in keyof PluginCommands]: (
    input: Omit<PluginCommands[K]["input"], keyof PluginContext>,
  ) => Promise<PluginCommands[K]["output"]>;
};
const pending = (): never => {
  throw new Error("Plugin management is not initialized");
};
export function usePluginCapabilities(
  _context: PluginContext,
): UseQueryResult<PluginManagementCapabilities, Error> {
  return pending();
}
export function usePublicPluginSections(
  _context: PluginContext,
): UseQueryResult<PublicPluginSections, Error> {
  return pending();
}
export function usePluginCategory(
  _context: PluginContext,
  _input: { slug: string; search?: string },
): PluginInfiniteQuery {
  return pending();
}
export function usePersonalPlugins(
  _context: PluginContext,
): UseQueryResult<PersonalPlugins, Error> {
  return pending();
}
export function useCreatedPlugins(_context: PluginContext): PersonalInfiniteQuery {
  return pending();
}
export function useSharedPlugins(_context: PluginContext): PersonalInfiniteQuery {
  return pending();
}
export function useInstalledPlugins(
  _context: PluginContext,
  _input: { search?: string } = {},
): PluginRowsQuery {
  return pending();
}
export function usePluginSearch(_context: PluginContext, _term: string): PluginInfiniteQuery {
  return pending();
}
export function usePluginDetail(
  _context: PluginContext,
  _selector: PluginSelector,
): UseQueryResult<PluginDetailView, Error> {
  return pending();
}
export function useSkills(_context: PluginContext): UseQueryResult<SkillsView, Error> {
  return pending();
}
export function useSkillContents(
  _context: PluginContext,
  _selector: SkillContentsSelector,
): UseQueryResult<{ readonly contents: string | null }, Error> {
  return pending();
}
export function usePluginManagement(_context: PluginContext): PluginManagement {
  return pending();
}
