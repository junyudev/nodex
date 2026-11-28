import { ConversationCarriedAudio } from "@/components/conversation-media/conversation-media";
import { useContentAudioSource } from "@/lib/content-image";

/**
 * A tool's audio result. Bytes the result carries play at once; bytes the Agent Runtime keeps for
 * the item load when the player mounts. A clip with neither shows as unavailable.
 */
export function ToolResultAudio({
  url,
  source,
  mimeType,
}: {
  readonly url: string | null;
  readonly source?: string;
  readonly mimeType?: string;
}) {
  return source ? (
    <AttachedToolResultAudio source={source} mimeType={mimeType} />
  ) : (
    <ConversationCarriedAudio url={url} mimeType={mimeType} className="my-0" />
  );
}

function AttachedToolResultAudio({
  source,
  mimeType,
}: {
  readonly source: string;
  readonly mimeType?: string;
}) {
  const audio = useContentAudioSource(source);
  return (
    <ConversationCarriedAudio
      url={audio.url}
      status={audio.status}
      mimeType={mimeType}
      className="my-0"
    />
  );
}
