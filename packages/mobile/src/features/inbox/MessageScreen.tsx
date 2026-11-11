import { useEffect } from "react";
import { Alert, ScrollView, View } from "react-native";

import { Markdown } from "../../markdown/Markdown";
import type { ScreenProps } from "../../navigation/types";
import {
  clearInboxNotifications,
  decideInbox,
  useAgentCatalog,
  useNewChatPreferences,
  useProjects,
} from "../../runtime";
import { formatStreamTime } from "../../ui/format";
import { Row, RowGroup, SectionLabel, Txt, lightTap } from "../../ui/primitives";
import { showFailure } from "../../ui/snackbar";
import { useNow } from "../../ui/use-now";
import { agentChipLabel, effectiveAgentChoice } from "../pickers/agent-choice";
import { EntryActions, SignatureLine } from "./InboxPane";
import {
  entryChatSession,
  laterLabel,
  messageChat,
  outcomeLabel,
  sourceLabel,
} from "./inbox-presentation";
import { SuggestionPanel, useInboxEntry } from "./Suggestion";
import { useDecide } from "./use-decide";

/** A whole message, and everything that can be decided about it. */
export const MessageScreen = ({ route, navigation }: ScreenProps<"Message">) => {
  const now = useNow();
  const { pageId, initial, openChat } = route.params;
  const [message, setMessage] = useInboxEntry(pageId, initial);
  const decide = useDecide();
  const { projects } = useProjects();
  const { catalog } = useAgentCatalog();
  const preferences = useNewChatPreferences();
  const project = projects.find((candidate) => candidate.id === preferences.projectId);
  const chat = message ? messageChat(message) : null;
  const startedChat = chat?.state === "open" && chat.sessionId === openChat ? openChat : null;

  // A chat started from here opens once its host has started it; until then this message shows
  // that it is starting, or why it could not start and whether Retry can.
  useEffect(() => {
    if (startedChat) navigation.replace("Chat", { sessionId: startedChat });
  }, [navigation, startedChat]);

  // Opening a message sees what the phone was told about it, whether by its Page or its chat.
  const seenSession = message ? entryChatSession(message) : null;
  useEffect(() => {
    clearInboxNotifications(pageId, seenSession);
  }, [pageId, seenSession]);

  if (!message) return <View className="flex-1 bg-surface" />;

  const chatSessionId = entryChatSession(message);
  if (message.rowKind !== "intake")
    return (
      <ScrollView
        className="flex-1 bg-surface"
        contentContainerClassName="gap-4 p-4"
        contentInsetAdjustmentBehavior="automatic"
      >
        <SignatureLine
          entry={message}
          time={formatStreamTime(Date.parse(message.submittedAt), now)}
        />
        {message.rowKind !== "answer" ? (
          <Txt className="font-medium text-ink">{message.title}</Txt>
        ) : null}
        {message.body ? (
          <Markdown
            text={message.body}
            actions={{ onOpenChat: (sessionId) => navigation.navigate("Chat", { sessionId }) }}
          />
        ) : null}
        <EntryActions entry={message} now={now} />
        {chatSessionId ? (
          <RowGroup>
            <Row
              icon="chat"
              label="Open its chat"
              onPress={() => navigation.navigate("Chat", { sessionId: chatSessionId })}
            />
          </RowGroup>
        ) : null}
      </ScrollView>
    );

  const decideAndClose = (decision: Parameters<typeof decide>[1], done: string) => {
    void decide(pageId, decision, done);
    navigation.goBack();
  };

  const chooseLater = () => navigation.navigate("InboxLaterPicker", { pageId });
  const canMarkDone = message.waiting;
  const deferred = message.later != null && Date.parse(message.later.until) > now;

  const startChatFromMessage = () => {
    lightTap();
    decideInbox(pageId, {
      type: "start_chat",
      projectId: preferences.projectId,
      prompt: null,
      agent: effectiveAgentChoice(catalog, preferences.agent),
    })
      .then(({ sessionId }) => {
        if (sessionId) navigation.setParams({ openChat: sessionId });
        else navigation.goBack();
      })
      .catch((cause: unknown) => showFailure("Could not start the chat", cause));
  };

  return (
    <ScrollView
      className="flex-1 bg-surface"
      contentContainerClassName="gap-5 p-4 pb-10"
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
          laterLabel(message, new Date(now)),
          outcomeLabel(message),
        ]
          .filter(Boolean)
          .join(" · ")}
      </Txt>
      <SuggestionPanel message={message} />
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
          <Row
            icon="chat"
            iconColor="accent"
            label={chat?.state === "starting" ? "Starting the chat…" : "Start chat"}
            disabled={chat?.state === "starting"}
            onPress={startChatFromMessage}
          />
        </RowGroup>
      </View>
      <RowGroup>
        {chat?.state === "open" ? (
          <Row
            icon="chat"
            label="Open its chat"
            onPress={() => navigation.navigate("Chat", { sessionId: chat.sessionId })}
          />
        ) : null}
        {message.suggestion.state === "none" && message.proposal === null ? (
          <Row
            icon="agent"
            label="Ask for a suggestion"
            onPress={() => decideAndClose({ type: "request_suggestion" }, "Asked for a suggestion")}
          />
        ) : null}
        {!message.waiting || deferred ? (
          <Row
            icon="undo"
            label="Return to Inbox"
            onPress={() =>
              decideAndClose({ type: deferred ? "clear_later" : "return" }, "Back in the Inbox")
            }
          />
        ) : null}
        {canMarkDone && message.source.kind !== "automation" ? (
          <Row icon="clock" label={deferred ? "Change time" : "Later"} onPress={chooseLater} />
        ) : null}
        {canMarkDone ? (
          <Row
            icon="check"
            label="Mark done"
            onPress={() => decideAndClose({ type: "done" }, "Marked done")}
          />
        ) : null}
        {message.waiting && message.source.kind !== "automation"
          ? (message.kind === "note"
              ? (["save_to_notes", "keep"] as const)
              : (["keep", "save_to_notes"] as const)
            ).map((type) => {
              const note = type === "save_to_notes";
              return (
                <Row
                  key={type}
                  icon={note ? "folder" : "check"}
                  label={note ? "Save to Notes" : "Add to Todo"}
                  onPress={() =>
                    decideAndClose({ type }, note ? "Saved to Notes" : "Added to Todo")
                  }
                />
              );
            })
          : null}
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
