export interface AgentToolOutputReference {
  readonly sessionId: string;
  readonly nativeMessageId: string;
  readonly toolUseId: string;
}

/** Explicit lazy read budget, independent of the much smaller resident transcript budget. */
export const AGENT_TOOL_OUTPUT_MAX_BYTES = 512 * 1024;

export interface AgentToolOutput {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalBytes: number;
}

/** UTF-8 clipping preserves complete characters and tells the caller whether native text remains. */
export const boundAgentToolOutput = (text: string): AgentToolOutput => {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= AGENT_TOOL_OUTPUT_MAX_BYTES)
    return { text, truncated: false, originalBytes: bytes.length };
  const bounded = bytes.slice(0, AGENT_TOOL_OUTPUT_MAX_BYTES);
  let end = bounded.length;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return {
    text: new TextDecoder().decode(bounded.slice(0, end)),
    truncated: true,
    originalBytes: bytes.length,
  };
};
