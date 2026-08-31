import type { VisibleConversationTurnEntry } from "../selectors";
import type { ThreadSearchUnitModel } from "../thread-stage-types";
import { selectTurnRenderModel } from "../projection/build-turn-render-model";

export type LocalConversationSearchSourceTurn = VisibleConversationTurnEntry;

interface CachedSearchTurnState {
  entry: VisibleConversationTurnEntry;
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

  const getUnitsForTurn = (entry: VisibleConversationTurnEntry): ThreadSearchUnitModel[] => {
    const cached = cachedUnitsByTurnKey.get(entry.turnKey);
    if (cached?.entry === entry) return cached.units;

    const units = selectTurnRenderModel({
      entry,
      canEditTurnUserPrefix: false,
      canForkTurn: false,
      cwd: input.cwd,
      projectlessOutputDirectory: input.projectlessOutputDirectory,
    }).searchUnits;
    cachedUnitsByTurnKey.set(entry.turnKey, { entry, units });
    return units;
  };

  return {
    ...input,
    getUnitsForTurn,
    findMatches(query: string): ThreadSearchUnitModel[] {
      const normalizedQuery = query.trim().toLowerCase();
      if (!normalizedQuery) return [];

      return input
        .getTurns()
        .flatMap((entry) =>
          getUnitsForTurn(entry).filter((unit) =>
            unit.text.toLowerCase().includes(normalizedQuery),
          ),
        );
    },
  };
}
