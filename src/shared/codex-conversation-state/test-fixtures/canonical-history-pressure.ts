import type { ClientRequestParamsByMethod, ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import type { CanonicalHistoryClient } from "../codex-canonical-history-loader";
import { createCodexCanonicalHydratedConversationState } from "../codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "./agent-activity-v2-corpus-provenance";

type Method = "thread/turns/list" | "thread/items/list";
type HistoryTurn = ClientRequestResponsesByMethod["thread/turns/list"]["data"][number];
type HistoryItem = ClientRequestResponsesByMethod["thread/items/list"]["data"][number]["item"];
export function makeCanonicalHistoryPressureFixture(turnCount: number, itemCount: number, textBytes = 20) {
  const thread = buildAgentActivityV2CorpusThread([]);
  const state = createCodexCanonicalHydratedConversationState(thread, { hostId: "local", model: "model", reasoningEffort: null, cwd: "/workspace", approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly", networkAccess: false }, activePermissionProfile: null, runtimeWorkspaceRoots: ["/workspace"] });
  const conversation = { ...state, historyMode: "paginated" as const, paginatedHistory: { turnsBackwardsCursor: null, itemsBackwardsCursor: null } };
  const calls: Array<{method: Method; params: ClientRequestParamsByMethod[Method]}> = [];
  const makeTurn = (id: number): HistoryTurn => ({ rootTurnId: null, id: String(id), items: [], itemsView: "notLoaded", status: "completed", error: null, startedAt: id, completedAt: id + 1, durationMs: 1 });
  const makeItem = (id: number): HistoryItem => ({type: "plan", id: String(id), text: "x".repeat(textBytes)});
  const handlers: {
    [M in Method]: (params: ClientRequestParamsByMethod[M]) => ClientRequestResponsesByMethod[M];
  } = {
    "thread/turns/list": (params) => {
      const end = params.cursor == null ? turnCount : Number(params.cursor);
      const start = Math.max(0, end - (params.limit ?? 5));
      return {data: Array.from({length:end-start},(_,index)=>makeTurn(end-index-1)), nextCursor:start===0?null:String(start), backwardsCursor:null};
    },
    "thread/items/list": (params) => {
      const turnId = params.turnId;
      if (turnId == null) throw new Error("Missing Turn identity");
      const ascending = params.sortDirection === "asc";
      const end = params.cursor == null ? itemCount : Number(params.cursor);
      const start = Math.max(0,end-(params.limit??100));
      const items = ascending ? [makeItem(0)] : Array.from({length:end-start},(_,index)=>makeItem(end-index-1));
      return {data:items.map(item=>({turnId,item})),nextCursor:ascending||start===0?null:String(start),backwardsCursor:null};
    },
  };
  const client: CanonicalHistoryClient = {
    hostId:"local",supportsPaginatedHistory:()=>true,getConversation:()=>conversation,
    sendRequest:async <M extends Method>(method:M,params:ClientRequestParamsByMethod[M]):Promise<ClientRequestResponsesByMethod[M]> => {calls.push({method,params});return handlers[method](params);},
    updateConversation:()=>{throw new Error("Page reads must not install history");},broadcastSnapshot:()=>{throw new Error("Page reads must not publish history");},mapTurns:()=>{throw new Error("Page reads must not project resident history");},
  };
  return {client,calls};
}
