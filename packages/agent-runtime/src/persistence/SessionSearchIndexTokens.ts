// SQLite treats this as one token. The analyzer never emits adjacent plain hash signs.
export const searchItemBoundary = "########";
export const searchTermTag = (field: "message" | "action") => `${field[0]}#`;
export const searchPairToken = (left: string, right: string) => `p#${left.length}#${left}${right}`;
