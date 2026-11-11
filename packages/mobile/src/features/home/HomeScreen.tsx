import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { useEffect, useRef, useState, type ComponentRef } from "react";
import { ScrollView, View, useWindowDimensions } from "react-native";
import { GestureDetector, useNativeGesture } from "react-native-gesture-handler";

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
import { BarControl } from "../../ui/BarControl";
import { cn } from "../../ui/cn";
import { ComposerLayout } from "../../ui/ComposerLayout";
import { Glass } from "../../ui/glass";
import { Icon, NodexMark } from "../../ui/icons";
import { Chip, Field, IconButton, StatusDot, Tap, Txt } from "../../ui/primitives";
import { useSideMenu, useSideMenuScreen } from "../../ui/SideMenu";
import { showFailure } from "../../ui/snackbar";
import { attentionCount } from "../chats/chat-sections";
import { ChatsPane } from "../chats/ChatsPane";
import { Composer } from "../composer/Composer";
import { SpaceAvatar } from "../../ui/SpaceAvatar";
import { useDecide } from "../inbox/use-decide";
import { capturePrompt } from "../inbox/inbox-choices";
import { InboxPane } from "../inbox/InboxPane";
import { useInboxChoices } from "../inbox/use-inbox-choices";
import { agentChipLabel } from "../pickers/agent-choice";
import { linkedSpace } from "../settings/space-presentation";
import { spaceUnreachable, ConnectionNotice } from "./ConnectionNotice";
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
      className={cn("h-9 flex-row items-center gap-1 rounded-full px-3.5", active && "bg-fill")}
      pressedClassName=""
      onPress={() => setMode(mode)}
    >
      <Txt className={cn("text-sm font-medium", active ? "text-ink" : "text-ink-2")}>{label}</Txt>
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

/** The Space being shown, which opens the menu of where else to look. */
const HomeLeading = () => {
  const menu = useSideMenu();
  const connection = useConnection();
  const { hosts, activeHostId } = useHosts();
  const host = hosts.find((host) => host.hostId === activeHostId);
  const hostName = host?.hostName ?? "this Space";
  return (
    <Tap
      accessibilityLabel={`${hostName}, ${connection.status}. Menu`}
      accessibilityState={{ expanded: menu.isOpen }}
      className="h-9 w-9 items-center justify-center"
      onPress={menu.open}
    >
      {host ? <SpaceAvatar space={linkedSpace(host)} size={28} /> : <NodexMark size={22} />}
      {connection.status === "connected" ? null : (
        <View className="absolute bottom-0.5 right-0.5">
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
  );
};

/** Which of the two Home shows, or the search that is narrowing its chats. */
const HomeTitle = () => {
  const { width } = useWindowDimensions();
  const search = useHomeState((state) => state.search);
  const setSearch = useHomeState((state) => state.setSearch);
  const { shown } = useInboxChoices();
  const filter = useHomeState((state) => state.filter);
  const allChats = useChats({});
  if (search !== null) {
    return (
      <Glass radius={22} style={{ width: width - 128 }}>
        <View className="h-11 flex-row items-center gap-1.5 px-3.5">
          <Icon name="search" size={17} color="ink-3" />
          <Field
            accessibilityLabel="Search chats"
            autoFocus
            className="h-11 flex-1 text-base text-ink"
            onChangeText={setSearch}
            returnKeyType="search"
            value={search}
          />
        </View>
      </Glass>
    );
  }
  return (
    <Glass radius={22}>
      <View accessibilityRole="tablist" className="flex-row p-1">
        <Segment
          mode="inbox"
          label={filter === "later" ? "Later" : "Inbox"}
          count={filter === "later" ? 0 : (shown?.count ?? 0)}
          countTone="muted"
        />
        <Segment
          mode="chats"
          label="Chats"
          count={attentionCount(allChats.items)}
          countTone="warning"
        />
      </View>
    </Glass>
  );
};

/** The one control the current pane adds: its history, or searching it. */
const HomeTrailing = () => {
  const mode = useHomeState((state) => state.mode);
  const filter = useHomeState((state) => state.filter);
  const navigation = useRootNavigation();
  const searching = useHomeState((state) => state.search !== null);
  const setSearch = useHomeState((state) => state.setSearch);
  if (searching) {
    return (
      <IconButton color="ink" label="Close search" name="close" onPress={() => setSearch(null)} />
    );
  }
  return mode === "inbox" ? (
    <IconButton
      color={filter === "inbox" ? "ink" : "accent"}
      label="Inbox views"
      name={filter === "later" ? "clock" : "history"}
      onPress={() => navigation.navigate("InboxViewPicker")}
    />
  ) : (
    <IconButton color="ink" label="Search chats" name="search" onPress={() => setSearch("")} />
  );
};

export const HOME_HEADER: NativeStackNavigationOptions = {
  title: "Home",
  headerLeft: () => (
    <BarControl>
      <HomeLeading />
    </BarControl>
  ),
  headerTitle: () => <HomeTitle />,
  headerRight: () => (
    <BarControl>
      <HomeTrailing />
    </BarControl>
  ),
};

/**
 * The app is one screen: a stream or a list passing beneath floating bars, and one Composer that
 * drops into the Inbox or starts a chat, depending on which the person is looking at.
 */
export const HomeScreen = () => {
  const navigation = useRootNavigation();
  const { width } = useWindowDimensions();
  const mode = useHomeState((state) => state.mode);
  const setMode = useHomeState((state) => state.setMode);
  const { scope, shown } = useInboxChoices();
  const search = useHomeState((state) => state.search);
  const noteCaptureSent = useHomeState((state) => state.noteCaptureSent);
  const connection = useConnection();
  const { hosts, activeHostId } = useHosts();
  const host = hosts.find((candidate) => candidate.hostId === activeHostId);
  const hostName = host?.hostName ?? "this Space";
  const storedReply = useHomeState((state) => state.replyTo);
  const replyTo = storedReply?.spaceKey === activeHostId ? storedReply : null;
  const setReplyTo = useHomeState((state) => state.setReplyTo);
  const decide = useDecide();
  const unreachable = spaceUnreachable(connection.status);
  const projects = useProjects();
  const catalog = useAgentCatalog();
  const preferences = useNewChatPreferences();
  const menu = useSideMenu();
  // The menu lies to the left of the Inbox: from Chats the same swipe goes back to the Inbox first.
  useSideMenuScreen(mode === "inbox");
  // At the Inbox the pager cannot move for a drag to the right, yet would still claim it. The
  // menu's drag runs beside the pager's, so the pager can never take it away.
  const paging = useNativeGesture({ simultaneousWith: menu.drag, disableReanimated: true });
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [starting, setStarting] = useState(false);
  const pager = useRef<ComponentRef<typeof ScrollView>>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery((search ?? "").trim()), 200);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    pager.current?.scrollTo({ x: mode === "inbox" ? 0 : width, animated: true });
  }, [mode, width]);

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
    <ComposerLayout
      foot={
        <>
          <ConnectionNotice />
          {mode === "inbox" && replyTo ? (
            <Composer
              key={replyTo.entryId}
              draftKey={`reply:${replyTo.entryId}`}
              placeholder="Reply"
              sendLabel="Reply"
              autoFocus
              canSend={!unreachable}
              canAttach={false}
              chips={
                <Chip
                  icon="close"
                  label={replyTo.title}
                  accessibilityLabel={`Stop replying to ${replyTo.title}`}
                  onPress={() => setReplyTo(null)}
                />
              }
              onSend={async (text) => {
                const sent = await decide(
                  replyTo.entryId,
                  { type: "turn_reply", episode: replyTo.episode, text },
                  "Replied",
                );
                if (sent) setReplyTo(null);
                return sent;
              }}
            />
          ) : mode === "inbox" ? (
            <Composer
              draftKey="inbox"
              placeholder={unreachable ? `No access to ${hostName}` : capturePrompt(shown)}
              sendLabel="Save to Inbox"
              // Captures wait out an outage, but never a Space this phone can no longer reach.
              canSend={!unreachable}
              chips={
                <Chip
                  icon="inbox"
                  label={shown?.label ?? "Project"}
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
        </>
      }
    >
      {(insets) => (
        <GestureDetector gesture={paging}>
          <ScrollView
            ref={pager}
            horizontal
            pagingEnabled
            bounces={false}
            contentInsetAdjustmentBehavior="never"
            contentOffset={{ x: mode === "inbox" ? 0 : width, y: 0 }}
            keyboardShouldPersistTaps="handled"
            scrollEnabled={search === null}
            scrollsToTop={false}
            showsHorizontalScrollIndicator={false}
            className="flex-1"
            onMomentumScrollEnd={(event) => {
              const page = Math.round(event.nativeEvent.contentOffset.x / width);
              setMode(page === 0 ? "inbox" : "chats");
            }}
          >
            <View style={{ width }}>
              <InboxPane insets={insets} />
            </View>
            <View style={{ width }}>
              <ChatsPane query={debouncedQuery} insets={insets} />
            </View>
          </ScrollView>
        </GestureDetector>
      )}
    </ComposerLayout>
  );
};
