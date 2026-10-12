import type { VisibleConversationTurnEntry } from "../selectors";
import type { ThreadSearchUnitModel } from "../thread-stage-types";
import { selectTurnRenderModel } from "../projection/build-turn-render-model";

export type LocalConversationSearchSourceTurn = VisibleConversationTurnEntry;

interface CachedSearchTurnState {
  readonly turnIdentity: number;
  readonly requestsIdentity: number;
  units: ThreadSearchUnitModel[];
}

export interface LocalConversationSearchSource {
  routeContextId: string;
  cwd?: string | null;
  projectlessOutputDirectory?: string | null;
  getTurns: () => LocalConversationSearchSourceTurn[];
  scrollAdapter: {
    scrollToTurn: (turnKey: string, options?: { signal?: AbortSignal }) => Promise<void>;
    getTurnContainer: (turnKey: string) => HTMLElement | null;
  };
}

export function createLocalConversationSearchSource(input: LocalConversationSearchSource) {
  const cachedUnitsByTurnKey = new Map<string, CachedSearchTurnState>();
  const identities = new WeakMap<object, number>();
  let nextIdentity = 0;
  const identityOf = (value: object): number => {
    const existing = identities.get(value);
    if (existing !== undefined) return existing;
    const identity = ++nextIdentity;
    identities.set(value, identity);
    return identity;
  };

  const pruneCachedData = (entries = input.getTurns()): void => {
    const current = new Map(entries.map((entry) => [entry.turnKey, entry]));
    for (const [key, cached] of cachedUnitsByTurnKey) {
      const entry = current.get(key);
      if (
        !entry ||
        cached.turnIdentity !== identityOf(entry.turn) ||
        cached.requestsIdentity !== identityOf(entry.requests)
      )
        cachedUnitsByTurnKey.delete(key);
    }
  };

  const getTurns = (): LocalConversationSearchSourceTurn[] => {
    const entries = input.getTurns();
    pruneCachedData(entries);
    return entries;
  };

  const getUnitsForTurn = (entry: VisibleConversationTurnEntry): ThreadSearchUnitModel[] => {
    const cached = cachedUnitsByTurnKey.get(entry.turnKey);
    const turnIdentity = identityOf(entry.turn);
    const requestsIdentity = identityOf(entry.requests);
    if (cached?.turnIdentity === turnIdentity && cached.requestsIdentity === requestsIdentity)
      return cached.units;

    const units = selectTurnRenderModel({
      entry,
      canEditTurnUserPrefix: false,
      canForkTurn: false,
      cwd: input.cwd,
      projectlessOutputDirectory: input.projectlessOutputDirectory,
    }).searchUnits;
    cachedUnitsByTurnKey.set(entry.turnKey, { turnIdentity, requestsIdentity, units });
    return units;
  };

  return {
    ...input,
    getTurns,
    getUnitsForTurn,
    clearCachedData: () => cachedUnitsByTurnKey.clear(),
    pruneCachedData,
    findMatches(query: string): ThreadSearchUnitModel[] {
      const normalizedQuery = query.trim().toLowerCase();
      if (!normalizedQuery) return [];

      return getTurns().flatMap((entry) =>
        getUnitsForTurn(entry).filter((unit) => unit.text.toLowerCase().includes(normalizedQuery)),
      );
    },
  };
}
