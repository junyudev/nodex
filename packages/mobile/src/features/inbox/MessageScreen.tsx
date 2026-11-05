import type { InboxMessage } from "@nodex/mobile-protocol";
import { useEffect, useState } from "react";
import { Alert, ScrollView, View } from "react-native";

import { Markdown } from "../../markdown/Markdown";
import type { ScreenProps } from "../../navigation/types";
import {
  decideInbox,
  fetchInboxMessage,
  useAgentCatalog,
  useNewChatPreferences,
  useProjects,
} from "../../runtime";
import { formatStreamTime } from "../../ui/format";
import { Row, RowGroup, SectionLabel, Txt, lightTap } from "../../ui/primitives";
import { showFailure } from "../../ui/snackbar";
import { useNow } from "../../ui/use-now";
import { agentChipLabel, effectiveAgentChoice } from "../pickers/agent-choice";
import { SuggestionLine, useDecide } from "./InboxPane";
import { outcomeLabel, sourceLabel } from "./inbox-presentation";

/** A whole message, and everything that can be decided about it. */
export const MessageScreen = ({ route, navigation }: ScreenProps<"Message">) => {
  const now = useNow();
  const { pageId, initial } = route.params;
  const [message, setMessage] = useState<InboxMessage | null>(initial ?? null);
  const decide = useDecide();
  const { projects } = useProjects();
  const { catalog } = useAgentCatalog();
  const preferences = useNewChatPreferences();
  const project = projects.find((candidate) => candidate.id === preferences.projectId);

  useEffect(() => {
    let current = true;
    fetchInboxMessage(pageId)
      .then((fresh) => {
        if (current) setMessage(fresh);
      })
      .catch(() => {
        // The stream's copy stays on screen; a stale read is better than an empty page.
      });
    return () => {
      current = false;
    };
  }, [pageId]);

  if (!message) return <View className="flex-1 bg-surface" />;

  const decideAndClose = (decision: Parameters<typeof decide>[1], done: string) => {
    void decide(pageId, decision, done);
    navigation.goBack();
  };

  const startChatFromMessage = () => {
    lightTap();
    decideInbox(pageId, {
      type: "start_chat",
      projectId: preferences.projectId,
      prompt: null,
      agent: effectiveAgentChoice(catalog, preferences.agent),
    })
      .then(({ sessionId }) => {
        if (sessionId) navigation.replace("Chat", { sessionId });
        else navigation.goBack();
      })
      .catch((cause: unknown) => showFailure("Could not start the chat", cause));
  };

  return (
    <ScrollView
      className="flex-1 bg-surface"
      contentContainerClassName="gap-4 p-4"
      contentInsetAdjustmentBehavior="automatic"
    >
      <Markdown
        text={message.body}
        actions={{ onOpenChat: (sessionId) => navigation.navigate("Chat", { sessionId }) }}
      />
      <Txt className="text-xs text-ink-3">
        {[
          message.pageKey,
          formatStreamTime(Date.parse(message.submittedAt), now),
          sourceLabel(message),
          outcomeLabel(message),
        ]
          .filter(Boolean)
          .join(" · ")}
      </Txt>
      <SuggestionLine message={message} />
      <View>
        <SectionLabel>Start a chat from this</SectionLabel>
        <RowGroup>
          <Row
            icon="folder"
            label={project?.name ?? "No project"}
            onPress={() => navigation.navigate("ProjectPicker", { projectOnly: true })}
          />
          <Row
            icon="agent"
            label={agentChipLabel(catalog, preferences.agent)}
            onPress={() => navigation.navigate("AgentPicker")}
          />
          <Row icon="chat" iconColor="accent" label="Start chat" onPress={startChatFromMessage} />
        </RowGroup>
      </View>
      <RowGroup>
        {message.chatSessionId ? (
          <Row
            icon="chat"
            label="Open its chat"
            onPress={() => navigation.navigate("Chat", { sessionId: message.chatSessionId ?? "" })}
          />
        ) : null}
        {message.suggestion.state === "none" && message.proposal === null ? (
          <Row
            icon="agent"
            label="Ask for a suggestion"
            onPress={() => decideAndClose({ type: "request_suggestion" }, "Asked for a suggestion")}
          />
        ) : null}
        {message.state === "open" ? (
          <>
            <Row
              icon="check"
              label="Mark done"
              onPress={() => decideAndClose({ type: "done" }, "Marked done")}
            />
            <Row
              icon="folder"
              label="Keep"
              detail="Stays as a Page and leaves the Inbox"
              onPress={() => decideAndClose({ type: "keep" }, "Kept")}
            />
          </>
        ) : (
          <Row
            icon="undo"
            label="Back to Inbox"
            onPress={() => decideAndClose({ type: "reopen" }, "Back in the Inbox")}
          />
        )}
        <Row
          icon={message.important ? "starFilled" : "star"}
          iconColor={message.important ? "warning" : "ink-2"}
          label={message.important ? "Not important" : "Important"}
          onPress={() => {
            setMessage({ ...message, important: !message.important });
            void decide(
              pageId,
              { type: "important", important: !message.important },
              message.important ? "No longer important" : "Marked important",
            );
          }}
        />
        <Row
          icon="trash"
          label="Delete"
          tone="danger"
          onPress={() =>
            Alert.alert("Delete this message?", "Its Page goes with it.", [
              { text: "Cancel", style: "cancel" },
              {
                text: "Delete",
                style: "destructive",
                onPress: () => decideAndClose({ type: "delete" }, "Deleted"),
              },
            ])
          }
        />
      </RowGroup>
    </ScrollView>
  );
};
