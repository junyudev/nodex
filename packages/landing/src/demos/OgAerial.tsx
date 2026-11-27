import { AerialBand, type AerialChat } from "../replica/Aerial";
import { useReplicaCopy } from "../replica/copy";
import type { MapSubagent } from "../replica/Subagents";
import { DemoLocaleProvider, useLumen } from "./demo-locale";
import { AGENTS } from "./lumen";

/**
 * The home social card's window: Aerial view with two chats at work, so the four peers each show
 * up doing something. A Claude lead hands its routes to Codex and its tests to Antigravity, and an
 * Antigravity lead's Codex subagent passes its screenshots to DeepSeek. Slightly enlarged, so its
 * names stay readable in a feed's thumbnail, and still, as a card is.
 */
export default function OgAerial({ narrow = false }: { readonly narrow?: boolean }) {
  return (
    <DemoLocaleProvider locale="en">
      <OgAerialBands narrow={narrow} />
    </DemoLocaleProvider>
  );
}

/**
 * `narrow` fits the GitHub card's narrower window, which gives its wider headline room. Its bands
 * must stay at least 34rem wide, or the delegation map stacks and loses its tree.
 */
function OgAerialBands({ narrow }: { readonly narrow: boolean }) {
  const story = useLumen();
  const copy = useReplicaCopy();
  const [webauthn, tests, docs] = story.subagents;
  const { settings } = story.aerial;
  const done = { edge: "returned", status: copy.done, tone: "settled" } as const;
  const passkeys: MapSubagent[] = [
    { ...webauthn, edge: "flowing", status: copy.elapsedMinutes(12) },
    { ...tests, ...done },
    { ...docs, ...done },
  ];
  const chats: AerialChat[] = [
    {
      id: "passkeys",
      project: "lumen-web",
      pageKey: story.inboxById.passkeys.key,
      agent: AGENTS.opus,
      title: story.titles.passkeys,
      status: copy.elapsedMinutes(17),
      line: story.wiringPasskeys,
      back: copy.backShort(2, 3),
      subagents: passkeys,
    },
    {
      id: "settings",
      project: "lumen-web",
      pageKey: story.inboxById.darkmode.key,
      agent: AGENTS.neon,
      title: story.titles.darkmode,
      status: copy.elapsedMinutes(9),
      line: settings.line,
      back: copy.backShort(2, 2),
      subagents: [
        { ...settings.audit, ...done },
        { ...settings.shots, ...done },
      ],
    },
  ];
  return (
    <div
      className={`flex h-full flex-col gap-7 px-6 ${narrow ? "justify-center [zoom:1]" : "pt-6 [zoom:1.1]"}`}
    >
      {chats.map((chat) => (
        <AerialBand key={chat.id} chat={chat} leadWidth={224} still />
      ))}
    </div>
  );
}
