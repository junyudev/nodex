import type { SearchTextQuery } from "@nodex/search-kernel/node";
import { searchPairToken, searchTermTag } from "../persistence/SessionSearchIndexTokens.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { readSearchSegments, searchableThread } from "../persistence/SessionSearchSources.ts";
import { fieldRank, STRONG_RANK_LIMIT } from "./SessionSearchText.ts";

const fields = ["message", "action"] as const;
export interface CatalogWordRanks {
  readonly threadId: string;
  readonly withoutTypos: readonly (number | null)[];
  readonly withTypos: readonly (number | null)[];
}
export interface IndexedHit {
  readonly lane: 0 | 1;
  readonly row_id: number;
  readonly at: string;
  readonly thread_id: string;
  readonly word: number;
  readonly word_rank: number;
  readonly weakest: number;
  readonly ordered: boolean;
  readonly hits: number;
}

interface ThreadMatch {
  readonly thread_id: string;
  readonly weakest: number;
  readonly best: string;
  readonly ordered: number;
  readonly message_max: number;
  readonly action_max: number;
}

const quote = (token: string) => `"${token.replaceAll('"', '""')}"`;
const term = (segments: readonly string[], prefix = false) =>
  `${quote(segments.join(" "))}${prefix ? "*" : ""}`;

interface MatchExpression {
  readonly expression: string;
  readonly positional: boolean;
}
interface Lookup extends MatchExpression {
  readonly word: number;
  readonly rank: number;
  readonly needles: readonly string[];
  readonly typo?: true;
}

const prepareLookups = Effect.fn("SessionSearch.prepareLookups")(function* (
  sql: SqlClient.SqlClient,
  query: SearchTextQuery,
  strongWords: readonly boolean[],
) {
  const words = query.words();
  const wordsByLane: Lookup[][] = [[], []];
  const add = (
    word: number,
    quality: Parameters<typeof fieldRank>[0],
    expression: (tag: string) => string,
    needles: readonly string[],
    positional = false,
  ) => {
    for (const [index, field] of fields.entries())
      wordsByLane[index]!.push({
        word,
        rank: fieldRank(quality, field),
        expression: positional
          ? `${field} : (${expression("")})`
          : expression(searchTermTag(field)),
        positional,
        needles,
        ...(quality === "typo" ? { typo: true as const } : {}),
      });
  };
  for (const [word, plan] of words.entries()) {
    const phrase = plan.segments.join(" ");
    const positional = plan.segments.length > 1;
    const token = (tag: string, prefix = false) =>
      term(
        plan.segments.map((value) => tag + value),
        prefix,
      );
    add(word, "exact", token, [` ${phrase} `], positional);
    if (plan.allowsPrefix)
      add(
        word,
        "prefix",
        (tag) => `${token(tag, true)} NOT ${token(tag)}`,
        [` ${phrase}`],
        positional,
      );
    const [needle] = plan.segments;
    if (plan.segments.length !== 1 || !needle) continue;
    if (plan.stem && plan.stem !== needle)
      add(word, "stem", (tag) => term([tag + plan.stem], true), [` ${plan.stem}`]);
    const chars = Array.from(needle);
    if (chars.length < 4) continue;
    const typo = !strongWords[word] && /\p{L}/u.test(needle);
    const first = chars[0]!;
    const swap = chars[1]! + first;
    const candidates = yield* sql<{ readonly term: string }>`SELECT term FROM session_search_terms
      WHERE instr(term,${needle})>1 ${
        typo
          ? sql`
        UNION SELECT term FROM session_search_terms WHERE length(term)>=${chars.length - 2} AND
          ((term>=${first} AND term<${first + "\u{10ffff}"}) OR (term>=${swap} AND term<${swap + "\u{10ffff}"}))`
          : sql``
      }`;
    const values = candidates.map(({ term }) => term);
    const infix = query.classify(word, values, false);
    const withTypos = typo ? query.classify(word, values, true) : [];
    for (const kind of ["typo", "infix"] as const) {
      const selected = values.filter(
        (_, index) => (kind === "typo" ? withTypos : infix)[index] === kind,
      );
      for (let start = 0; start < selected.length; start += 48) {
        const terms = selected.slice(start, start + 48);
        add(
          word,
          kind,
          (tag) => terms.map((value) => quote(tag + value)).join(" OR "),
          terms.map((value) => ` ${value} `),
        );
      }
    }
  }
  const phrase = yield* orderedLookup(sql, words);
  return { wordsByLane, phrase };
});

const orderedExpression = (words: ReturnType<SearchTextQuery["words"]>) =>
  words.map(({ segments, allowsPrefix }) => term(segments, allowsPrefix)).join(" + ");

/** The short-pair lookup reads one posting per chat, even for a phrase repeated in every item. */
const orderedLookup = Effect.fn("SessionSearch.orderedLookup")(function* (
  sql: SqlClient.SqlClient,
  words: ReturnType<SearchTextQuery["words"]>,
) {
  if (words.length < 2) return null;
  const positional: MatchExpression = {
    expression: `{message action} : (${orderedExpression(words)})`,
    positional: true,
  };
  if (
    words.length !== 2 ||
    words.some(({ segments }) => segments.length !== 1 || Array.from(segments[0]!).length < 4)
  )
    return positional;

  const maxPairs = 48;
  const terms = yield* Effect.forEach(words, ({ segments, allowsPrefix }) => {
    const segment = segments[0]!;
    if (!allowsPrefix) return Effect.succeed([{ term: segment }]);
    return sql<{ readonly term: string }>`SELECT term FROM session_search_terms
      WHERE term>=${segment} AND term<${segment + "\u{10ffff}"} LIMIT ${maxPairs + 1}`;
  });
  const [left, right] = terms;
  const count = left!.length * right!.length;
  if (!count) return null;
  // This bound chooses an equivalent lookup. Larger expansions use exact positional FTS.
  if (count > maxPairs || terms.some((list) => list.some(({ term }) => term.length >= 4000)))
    return positional;
  return {
    expression: left!
      .flatMap(({ term: left }) =>
        right!.map(({ term: right }) => quote(searchPairToken(left, right))),
      )
      .join(" OR "),
    positional: false,
  };
});

type LookupPlan = Effect.Success<ReturnType<typeof prepareLookups>>;

export const indexedHistory = Effect.fn("SessionSearch.rankIndex")(function* (
  sql: SqlClient.SqlClient,
  query: SearchTextQuery,
  threadIds: readonly string[] | undefined,
  metadata: readonly CatalogWordRanks[],
  initialStrong: readonly boolean[],
) {
  const plan = yield* prepareLookups(sql, query, initialStrong);
  const entries = plan.wordsByLane.flat().map(({ needles: _needles, ...entry }) => entry);
  const phrase = plan.phrase;
  const wordCount = query.words().length;
  const scope = threadIds === undefined ? sql`1` : sql`thread_id IN (SELECT id FROM scope)`;
  // Missing and incomplete native roots are both partial. Start with the requested IDs and
  // stop at the first gap, without walking the pending index queue for those roots.
  const nativePending =
    threadIds === undefined
      ? sql`EXISTS(SELECT 1 FROM session_search_native_threads WHERE complete=0)`
      : sql`EXISTS(SELECT 1 FROM scope requested
        LEFT JOIN session_search_native_threads native ON native.thread_id=requested.id
        WHERE substr(requested.id,1,8)='native:[' AND native.complete IS NOT 1)`;
  const lookupTable = (positional: boolean) =>
    sql(positional ? "session_search_words" : "session_search_inventory");
  const byLookup = (positional: boolean) => {
    const table = lookupTable(positional);
    // Drive the lookup from matching postings. A scoped chat without a published document
    // does not require a seek into the index or the dirty queue.
    return sql`SELECT ready.thread_id,lookup.word,lookup.rank,lookup.typo
      FROM lookup CROSS JOIN ${table} search
      CROSS JOIN session_search_threads ready ON ready.id=search.rowid
      WHERE lookup.positional=${Number(positional)} AND ${table} MATCH lookup.expression
        AND ${scope}
        AND NOT EXISTS(SELECT 1 FROM session_search_dirty dirty WHERE dirty.thread_id=ready.thread_id)`;
  };
  const orderedTable = phrase ? lookupTable(phrase.positional) : null;
  const [result] = yield* sql<{
    readonly facts: string;
    readonly strong: string;
    readonly incomplete: number;
  }>`
    WITH scope(id) AS (SELECT value FROM json_each(${JSON.stringify(threadIds ?? [])})), lookup AS MATERIALIZED (
      SELECT json_extract(value,'$.word') AS word,json_extract(value,'$.rank') AS rank,
        json_extract(value,'$.expression') AS expression,json_extract(value,'$.positional') AS positional,
        COALESCE(json_extract(value,'$.typo'),0) AS typo
      FROM json_each(${JSON.stringify(entries)})
    ), indexed AS MATERIALIZED (
      ${byLookup(false)} UNION ALL ${byLookup(true)}
    ), catalog AS MATERIALIZED (
      SELECT json_extract(doc.value,'$.threadId') AS thread_id,
        base.key AS word,base.value AS rank,json_extract(doc.value,'$.withTypos[' || base.key || ']') AS with_typo
      FROM json_each(${JSON.stringify(metadata)}) doc CROSS JOIN json_each(doc.value,'$.withoutTypos') base
    ), strong AS MATERIALIZED (
      SELECT DISTINCT word FROM indexed WHERE rank<${STRONG_RANK_LIMIT}
      UNION SELECT word FROM catalog WHERE rank<${STRONG_RANK_LIMIT}
      UNION SELECT key FROM json_each(${JSON.stringify(initialStrong)}) WHERE value
    ), evidence AS MATERIALIZED (
      SELECT thread_id,word,MIN(rank) AS rank,MIN(CASE WHEN from_history THEN rank END) AS history
      FROM (
        SELECT thread_id,word,rank,1 AS from_history FROM indexed WHERE NOT typo OR word NOT IN (SELECT word FROM strong)
        UNION ALL
        SELECT thread_id,word,CASE WHEN word IN (SELECT word FROM strong) THEN rank ELSE with_typo END,0 FROM catalog
      ) WHERE rank IS NOT NULL GROUP BY thread_id,word
    ), complete AS (
      SELECT thread_id,MAX(rank) AS weakest,json_group_object(word,rank) AS best FROM evidence
      GROUP BY thread_id HAVING COUNT(*)=${wordCount} AND MAX(history=rank)
    ), ordered AS MATERIALIZED (
      ${phrase && orderedTable ? sql`SELECT rowid FROM ${orderedTable} WHERE ${orderedTable} MATCH ${phrase.expression}` : sql`SELECT NULL AS rowid WHERE 0`}
    ) SELECT
      (SELECT json_group_array(json_object('thread_id',thread_id,'weakest',weakest,'best',best,'ordered',ordered,'message_max',message_max,'action_max',action_max)) FROM (
        SELECT thread_id,weakest,best,ordered.rowid IS NOT NULL AS ordered,message_max,action_max
        FROM complete JOIN session_search_threads ready USING(thread_id)
        LEFT JOIN ordered ON ordered.rowid=ready.id
        ORDER BY weakest,ordered DESC,at DESC,MAX(message_max,action_max) DESC,thread_id
      )) AS facts,
      (SELECT json_group_array(word) FROM strong) AS strong,
      CASE WHEN ${nativePending} THEN 1 ELSE EXISTS(
        SELECT 1 FROM session_search_dirty dirty WHERE ${scope} AND (
          EXISTS(SELECT 1 FROM orchestration_v2_projection_threads thread WHERE thread.thread_id=dirty.thread_id
            AND ${searchableThread(sql, "thread")})
          OR EXISTS(SELECT 1 FROM session_search_native_threads native WHERE native.thread_id=dirty.thread_id)
        )
      ) END AS incomplete`;
  const words = new Set(JSON.parse(result!.strong) as number[]);
  return {
    threads: JSON.parse(result!.facts) as ThreadMatch[],
    plan,
    strongWords: Array.from({ length: wordCount }, (_, index) => words.has(index)),
    truncated: Boolean(result!.incomplete),
  };
});

export type RankedHistory = Effect.Success<ReturnType<typeof indexedHistory>>;

interface ItemRow {
  readonly thread_id: string;
  readonly lane: 0 | 1;
  readonly row_id: number;
  readonly at: string;
  readonly user_role: number;
  readonly segments: string;
}
interface Evidence {
  readonly row: ItemRow;
  readonly word: number;
  readonly word_rank: number;
  readonly covered: number;
  readonly ordered: boolean;
}

const compareEvidence = (left: Evidence, right: Evidence) =>
  Number(right.ordered) - Number(left.ordered) ||
  right.covered - left.covered ||
  right.word_rank - left.word_rank ||
  right.row.user_role - left.row.user_role ||
  right.row.at.localeCompare(left.row.at) ||
  right.row.row_id - left.row.row_id ||
  left.row.lane - right.row.lane;

function phrasePattern(query: SearchTextQuery) {
  const words = query.words();
  if (words.length < 2) return null;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    ` ${words
      .map(
        ({ segments, allowsPrefix }) =>
          segments.map(escape).join(" ") + (allowsPrefix ? "[^ ]*" : ""),
      )
      .join(" ")} `,
  );
}

function inspectItem(
  row: ItemRow,
  thread: ThreadMatch,
  lookups: readonly Lookup[],
  phrase: RegExp | null,
): Evidence | null {
  const segments = ` ${row.segments} `;
  const ordered = thread.ordered === 1 && (phrase?.test(segments) ?? false);
  const matched = new Map<number, number>();
  for (const lookup of lookups) {
    if (matched.has(lookup.word)) continue;
    if (lookup.needles.some((needle) => segments.includes(needle)))
      matched.set(lookup.word, lookup.rank);
  }
  if (!matched.size && !ordered) return null;
  let word = -1;
  let wordRank = -1;
  for (const [index, rank] of matched) {
    if (rank < wordRank || (rank === wordRank && index > word)) continue;
    word = index;
    wordRank = rank;
  }
  return { row, word, word_rank: wordRank, covered: matched.size, ordered };
}

/** Keep common one-word evidence in the SQLite reader. Only the winning item and count
 * cross the worker boundary, even when the word appears in many items of the chat. */
const chooseSingleWordItems = Effect.fn("SessionSearch.chooseSingleWordItems")(function* (
  sql: SqlClient.SqlClient,
  selection: readonly {
    readonly threadId: string;
    readonly lane: 0 | 1;
    readonly through: number;
    readonly needle: string;
    readonly rank: number;
    readonly weakest: number;
  }[],
) {
  const rows = yield* sql<IndexedHit>`WITH matches AS (
    SELECT item.thread_id,item.lane,item.row_id,item.at,0 AS word,scope.rank AS word_rank,
      scope.weakest,0 AS ordered,COUNT(*) OVER (PARTITION BY item.thread_id) AS hits,
      ROW_NUMBER() OVER (PARTITION BY item.thread_id
        ORDER BY item.user_role DESC,item.at DESC,item.row_id DESC) AS position
    FROM (
      SELECT json_extract(value,'$.threadId') AS thread_id,json_extract(value,'$.lane') AS lane,
        json_extract(value,'$.through') AS through,json_extract(value,'$.needle') AS needle,
        json_extract(value,'$.rank') AS rank,json_extract(value,'$.weakest') AS weakest
      FROM json_each(${JSON.stringify(selection)})
    ) scope CROSS JOIN session_search_items item
      ON item.thread_id=scope.thread_id AND item.lane=scope.lane AND item.row_id<=scope.through
    WHERE NOT EXISTS(SELECT 1 FROM session_search_dirty dirty WHERE dirty.thread_id=scope.thread_id)
      AND instr(' '||${readSearchSegments(sql, "item")}||' ',scope.needle)>0
  ) SELECT thread_id,lane,row_id,at,word,word_rank,weakest,ordered,hits FROM matches WHERE position=1`;
  const byThread = new Map(rows.map((row) => [row.thread_id, { ...row, ordered: false }]));
  return selection.map(({ threadId }) => byThread.get(threadId) ?? null);
});

/** Inspect index text only in the requested chats. Original items are still read by point lookup. */
export const chooseSearchItems = Effect.fn("SessionSearch.chooseItems")(function* (
  sql: SqlClient.SqlClient,
  query: SearchTextQuery,
  plan: LookupPlan,
  threads: readonly ThreadMatch[],
  strong: readonly boolean[],
) {
  if (!threads.length) return [];
  const lookups = plan.wordsByLane.map((lane) =>
    lane.filter(({ word, typo }) => !typo || !strong[word]),
  );
  const ordered = orderedExpression(query.words());
  const chats = threads.map((thread) => {
    const best = JSON.parse(thread.best) as Record<number, number>;
    const winning = lookups.map((field) => field.filter(({ word, rank }) => best[word] === rank));
    const lanes = ([0, 1] as const).flatMap<{ lane: 0 | 1; verify: string | null }>((lane) => {
      if (winning[lane]!.length) return [{ lane, verify: null }];
      const through = lane === 0 ? thread.message_max : thread.action_max;
      if (thread.ordered === 1 && through > 0)
        return [{ lane, verify: `${fields[lane]} : (${ordered})` }];
      return [];
    });
    return { thread, winning, lanes };
  });
  if (!plan.phrase && query.words().length === 1) {
    const singleWord = chats.flatMap(({ thread, winning, lanes }) => {
      const lane = lanes[0]?.lane;
      if (lanes.length !== 1 || lane === undefined || winning[lane]?.length !== 1) return [];
      const [lookup] = winning[lane];
      if (!lookup || lookup.needles.length !== 1) return [];
      return [
        {
          threadId: thread.thread_id,
          lane,
          through: lane === 0 ? thread.message_max : thread.action_max,
          needle: lookup.needles[0]!,
          rank: lookup.rank,
          weakest: thread.weakest,
        },
      ];
    });
    if (singleWord.length === chats.length) return yield* chooseSingleWordItems(sql, singleWord);
  }
  const selection = chats.map(({ thread: { thread_id, message_max, action_max }, lanes }) => ({
    thread_id,
    message_max,
    action_max,
    lanes,
  }));
  // An ordered phrase can supply the excerpt from either field. For fields
  // without a winning word, confirm it by point lookup before loading their text.
  const rows = yield* sql<ItemRow>`WITH evidence_fields AS MATERIALIZED (
      SELECT thread.thread_id,json_extract(field.value,'$.lane') AS lane,
        json_extract(chat.value,CASE json_extract(field.value,'$.lane') WHEN 0 THEN '$.message_max' ELSE '$.action_max' END) AS through
      FROM json_each(${JSON.stringify(selection)}) chat
      CROSS JOIN json_each(chat.value,'$.lanes') field
      JOIN session_search_threads thread ON thread.thread_id=json_extract(chat.value,'$.thread_id')
      WHERE NOT EXISTS(SELECT 1 FROM session_search_dirty dirty WHERE dirty.thread_id=thread.thread_id)
        AND (json_extract(field.value,'$.verify') IS NULL OR EXISTS(
          SELECT 1 FROM session_search_words WHERE rowid=thread.id
            AND session_search_words MATCH json_extract(field.value,'$.verify')
        ))
    ) SELECT item.thread_id,item.lane,item.row_id,item.at,item.user_role,${readSearchSegments(sql, "item")} AS segments
      FROM evidence_fields field CROSS JOIN session_search_items item
        ON item.thread_id=field.thread_id AND item.lane=field.lane AND item.row_id<=field.through`;
  const byThread = new Map<string, ItemRow[]>();
  for (const row of rows) {
    const grouped = byThread.get(row.thread_id);
    if (grouped) grouped.push(row);
    else byThread.set(row.thread_id, [row]);
  }
  const phrase = phrasePattern(query);
  return chats.map(({ thread, winning }): IndexedHit | null => {
    const evidence = (byThread.get(thread.thread_id) ?? []).flatMap((row) => {
      const item = inspectItem(row, thread, winning[row.lane]!, phrase);
      return item ? [item] : [];
    });
    const match = evidence.reduce<Evidence | null>(
      (best, item) => (!best || compareEvidence(item, best) < 0 ? item : best),
      null,
    );
    if (!match) return null;
    return {
      lane: match.row.lane,
      row_id: match.row.row_id,
      at: match.row.at,
      thread_id: thread.thread_id,
      word: match.word,
      word_rank: match.word_rank,
      weakest: thread.weakest,
      ordered: match.ordered,
      hits: evidence.filter(
        ({ ordered, covered, word_rank }) =>
          ordered === match.ordered && covered === match.covered && word_rank === match.word_rank,
      ).length,
    };
  });
});
