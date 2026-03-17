export interface KanbanDropCapabilities {
  allowCardTargets: boolean;
  allowColumnTargets: boolean;
}

export function resolveKanbanDropCapabilities(args: {
  hasNonDefaultSort: boolean;
}): KanbanDropCapabilities {
  if (args.hasNonDefaultSort) {
    return {
      allowCardTargets: false,
      allowColumnTargets: true,
    };
  }

  return {
    allowCardTargets: true,
    allowColumnTargets: true,
  };
}
