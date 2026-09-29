import { expect, test } from "vite-plus/test";
import { buildAgentHistoryImageSource, parseAgentHistoryImageSource } from "./agent-history-images";

test("native image observations preserve session UUID and content index without content bytes", () => {
  const reference = { sessionId: "session-uuid", nativeMessageId: "message-uuid", index: 3 };
  expect(parseAgentHistoryImageSource(buildAgentHistoryImageSource(reference))).toEqual(reference);
  for (const source of [
    "/tmp/image.png",
    "file:///tmp/image.png",
    "nodex-native-image:session/%2Ftmp%2Ffile/1",
    "nodex-native-image:session/message/-1",
    "nodex-native-image:session/message/9007199254740993",
    "nodex-native-image:session/message/10001",
    "nodex-native-image:session/%ZZ/0",
  ])
    expect(parseAgentHistoryImageSource(source)).toBeNull();
});
