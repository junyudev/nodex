import { useEffect, useRef, useState, type ComponentRef } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useRootNavigation } from "../../navigation/types";
import {
  captureToInbox,
  startChat,
  useAgentCatalog,
  useChats,
  useConnection,
  useHosts,
  useNewChatPreferences,
  useProjects,
  type LocalImage,
} from "../../runtime";
import { cn } from "../../ui/cn";
import { Icon, NodexMark } from "../../ui/icons";
import { Chip, Field, IconButton, StatusDot, Tap, Txt } from "../../ui/primitives";
import { showFailure } from "../../ui/snackbar";
import { attentionCount } from "../chats/chat-sections";
import { ChatsPane } from "../chats/ChatsPane";
import { Composer } from "../composer/Composer";
import { InboxPane } from "../inbox/InboxPane";
import { agentChipLabel } from "../pickers/agent-choice";
import { ConnectionNotice } from "./ConnectionNotice";
import { useHomeState, type HomeMode } from "./home-state";

const Segment = ({
  mode,
  label,
  count,
  countTone,
}: {
  readonly mode: HomeMode;
  readonly label: string;
  readonly count: number;
  readonly countTone: "muted" | "warning";
}) => {
  const active = useHomeState((state) => state.mode === mode);
  const setMode = useHomeState((state) => state.setMode);
  return (
    <Tap
      accessibilityRole="tab"
      accessibilityState={{ selected: active }}
      className={cn(
        "h-8 flex-row items-center gap-1 rounded-full px-3.5",
        active && "bg-surface-3",
      )}
      pressedClassName=""
      onPress={() => setMode(mode)}
    >
      <Txt className={cn("text-sm font-medium", active ? "text-ink" : "text-ink-3")}>{label}</Txt>
      {count > 0 ? (
        <Txt
          className={cn(
            "text-xs font-medium",
            countTone === "warning" ? "text-warning" : "text-ink-3",
          )}
        >
          {count}
        </Txt>
      ) : null}
    </Tap>
  );
};

/**
 * The app is one screen: a stream or a list above, and one Composer below that drops into the Inbox
 * or starts a chat, depending on which the person is looking at.
 */
export const HomeScreen = () => {
  const navigation = useRootNavigation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const mode = useHomeState((state) => state.mode);
  const setMode = useHomeState((state) => state.setMode);
  const scope = useHomeState((state) => state.scope);
  const filter = useHomeState((state) => state.filter);
  const toggleFilter = useHomeState((state) => state.toggleFilter);
  const noteCaptureSent = useHomeState((state) => state.noteCaptureSent);
  const connection = useConnection();
  const { hosts, activeHostId } = useHosts();
  const host = hosts.find((candidate) => candidate.hostId === activeHostId);
  const projects = useProjects();
  const catalog = useAgentCatalog();
  const preferences = useNewChatPreferences();
  const allChats = useChats({});
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [starting, setStarting] = useState(false);
  const pager = useRef<ComponentRef<typeof ScrollView>>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    pager.current?.scrollTo({ x: mode === "inbox" ? 0 : width, animated: true });
  }, [mode, width]);

  const hostName = host?.hostName ?? "your desktop";
  const scopedProject =
    scope.kind === "project"
      ? projects.projects.find((project) => project.id === scope.projectId)
      : undefined;
  const inboxCount =
    scope.kind === "library" ? projects.libraryInboxCount : (scopedProject?.inboxCount ?? 0);
  const scopeLabel = scope.kind === "library" ? "Library" : (scopedProject?.name ?? "Project");
  const chatProject = projects.projects.find((project) => project.id === preferences.projectId);

  const beginChat = (text: string, images: readonly LocalImage[]): Promise<boolean> => {
    setStarting(true);
    return startChat({
      projectId: preferences.projectId,
      text,
      images: [...images],
      agent: preferences.agent,
      location: preferences.location,
    })
      .then(({ sessionId }) => {
        navigation.navigate("Chat", { sessionId });
        return true;
      })
      .catch((cause: unknown) => {
        showFailure("Could not start the chat", cause);
        return false;
      })
      .finally(() => setStarting(false));
  };

  return (
    <View className="flex-1 bg-surface" style={{ paddingTop: insets.top }}>
      {searching ? (
        <View className="h-12 flex-row items-center gap-1 pl-4 pr-2">
          <Icon name="search" size={18} color="ink-3" />
          <Field
            accessibilityLabel="Search chats"
            autoFocus
            className="h-10 flex-1 px-1.5 text-base text-ink"
            onChangeText={setQuery}
            returnKeyType="search"
            value={query}
          />
          <IconButton
            label="Close search"
            name="close"
            onPress={() => {
              setSearching(false);
              setQuery("");
            }}
          />
        </View>
      ) : (
        <View className="h-12 flex-row items-center justify-between px-2">
          <Tap
            accessibilityLabel={`${hostName}, ${connection.status}. Settings`}
            className="h-9 w-9 items-center justify-center"
            onPress={() => navigation.navigate("Settings")}
          >
            <NodexMark size={24} />
            {connection.status === "connected" ? null : (
              <View className="absolute bottom-1 right-1">
                <StatusDot
                  tone={
                    connection.status === "connecting"
                      ? "ink-3"
                      : connection.status === "offline"
                        ? "warning"
                        : "danger"
                  }
                />
              </View>
            )}
          </Tap>
          <View accessibilityRole="tablist" className="flex-row">
            <Segment mode="inbox" label="Inbox" count={inboxCount} countTone="muted" />
            <Segment
              mode="chats"
              label="Chats"
              count={attentionCount(allChats.items)}
              countTone="warning"
            />
          </View>
          {mode === "inbox" ? (
            <IconButton
              accessibilityState={{ selected: filter === "processed" }}
              color={filter === "processed" ? "accent" : "ink-2"}
              label={filter === "processed" ? "Show waiting messages" : "Show handled messages"}
              name="history"
              onPress={toggleFilter}
            />
          ) : (
            <IconButton label="Search chats" name="search" onPress={() => setSearching(true)} />
          )}
        </View>
      )}

      <ConnectionNotice />

      <KeyboardAvoidingView behavior="padding" className="flex-1">
        <ScrollView
          ref={pager}
          horizontal
          pagingEnabled
          bounces={false}
          contentOffset={{ x: mode === "inbox" ? 0 : width, y: 0 }}
          keyboardShouldPersistTaps="handled"
          scrollEnabled={!searching}
          showsHorizontalScrollIndicator={false}
          className="flex-1"
          onMomentumScrollEnd={(event) => {
            const page = Math.round(event.nativeEvent.contentOffset.x / width);
            setMode(page === 0 ? "inbox" : "chats");
          }}
        >
          <View style={{ width }}>
            <InboxPane />
          </View>
          <View style={{ width }}>
            <ChatsPane query={debouncedQuery} />
          </View>
        </ScrollView>

        {mode === "inbox" ? (
          <Composer
            draftKey="inbox"
            placeholder="Drop a thought"
            sendLabel="Save to Inbox"
            chips={
              <Chip
                icon="inbox"
                label={scopeLabel}
                trailingChevron
                onPress={() => navigation.navigate("ScopePicker")}
              />
            }
            onSend={(text, images) => {
              captureToInbox({ scope, text, images: [...images] });
              noteCaptureSent();
            }}
          />
        ) : (
          <Composer
            draftKey="new-chat"
            placeholder="Start a chat"
            sendLabel="Start chat"
            canSend={connection.status === "connected"}
            sending={starting}
            chips={
              <>
                <Chip
                  icon={preferences.location === "worktree" ? "branch" : "folder"}
                  label={chatProject?.name ?? "No project"}
                  trailingChevron
                  onPress={() => navigation.navigate("ProjectPicker")}
                />
                <Chip
                  icon="agent"
                  label={agentChipLabel(catalog.catalog, preferences.agent)}
                  trailingChevron
                  onPress={() => navigation.navigate("AgentPicker")}
                />
              </>
            }
            onSend={beginChat}
          />
        )}
      </KeyboardAvoidingView>
    </View>
  );
};
