/** References are observations only; Main validates the owning Thread and native session. */
export interface AgentHistoryImageReference {
  readonly sessionId: string;
  readonly nativeMessageId: string;
  readonly index: number;
}
export interface AgentPromptImageDescriptor {
  readonly nativeMessageId: string;
  readonly index: number;
  readonly mediaType: string;
}
const boundedIdentity = (value: string) =>
  value.length > 0 && value.length <= 256 && /^[a-zA-Z0-9_.-]+$/u.test(value);
export const buildAgentHistoryImageSource = (reference: AgentHistoryImageReference): string =>
  `nodex-native-image:${encodeURIComponent(reference.sessionId)}/${encodeURIComponent(reference.nativeMessageId)}/${reference.index}`;
export const parseAgentHistoryImageSource = (source: string): AgentHistoryImageReference | null => {
  if (source.length > 600) return null;
  const match = /^nodex-native-image:([^/]+)\/([^/]+)\/(\d+)$/u.exec(source);
  if (!match) return null;
  try {
    const sessionId = decodeURIComponent(match[1]!);
    const nativeMessageId = decodeURIComponent(match[2]!);
    const index = Number(match[3]);
    if (
      !boundedIdentity(sessionId) ||
      !boundedIdentity(nativeMessageId) ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index > 10000
    )
      return null;
    return { sessionId, nativeMessageId, index };
  } catch {
    return null;
  }
};
