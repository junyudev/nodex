export interface CodexTerminalInteractionIdentity {
  readonly conversationId: string;
  readonly itemId: string;
}

/** Interpret terminal controls while retaining incomplete input between notifications. */
export function parseCodexTerminalInput(
  inputBuffer: string,
  stdin: string,
): {
  commands: string[];
  inputBuffer: string;
} {
  const commands: string[] = [];
  let input = inputBuffer;
  let segmentStart = 0;
  for (let index = 0; index < stdin.length; index += 1) {
    const char = stdin[index];
    if (char !== "\r" && char !== "\n" && char !== "\u0003" && char !== "\b" && char !== "\u007f")
      continue;
    input += stdin.slice(segmentStart, index);
    segmentStart = index + 1;
    if (char === "\r" || char === "\n") {
      const command = input.trim();
      if (command.length > 0) commands.push(command);
      input = "";
      continue;
    }
    input = char === "\u0003" ? "" : input.slice(0, -1);
  }
  return { commands, inputBuffer: input + stdin.slice(segmentStart) };
}

export function getTerminalInteractionBufferKey(
  identity: CodexTerminalInteractionIdentity,
): string {
  return `${identity.conversationId}:${identity.itemId}`;
}

/** Input belongs to a command item, even when later notifications carry a different turn ID. */
export class CodexTerminalInteractionAccumulator {
  private readonly buffers = new Map<string, string>();

  accept(
    identity: CodexTerminalInteractionIdentity,
    stdin: string,
  ): { commands: readonly string[] } {
    const key = getTerminalInteractionBufferKey(identity);
    const result = parseCodexTerminalInput(this.buffers.get(key) ?? "", stdin);
    if (result.inputBuffer.length > 0) this.buffers.set(key, result.inputBuffer);
    else this.buffers.delete(key);
    return { commands: result.commands };
  }

  clearItem(identity: CodexTerminalInteractionIdentity): void {
    this.buffers.delete(getTerminalInteractionBufferKey(identity));
  }

  clearItems(conversationId: string, itemIds: readonly string[]): void {
    for (const itemId of itemIds) this.clearItem({ conversationId, itemId });
  }

  clearConversation(conversationId: string): void {
    const prefix = `${conversationId}:`;
    for (const key of this.buffers.keys()) {
      if (key.startsWith(prefix)) this.buffers.delete(key);
    }
  }

  clear(): void {
    this.buffers.clear();
  }
}
