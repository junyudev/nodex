/** A physical page that cannot advance is distinct from a failed history read. */
export class CodexHistoryCursorStalled extends Error {
  constructor(message = "History cursor did not advance") {
    super(message);
    this.name = "CodexHistoryCursorStalled";
  }
}
