# Mini Behavior

## Intent

Mini is Nodex's small presence over other apps. It shows how your chats stand without switching
to Nodex, answers in place what a short answer settles, and starts a chat in a few keystrokes.
It reads and acts through the same Member companion contract as the phone, so a chat that needs
you, a Turn that is your move, and what each action does read exactly as they do there.

## On screen

- **Dock.** A small pill: `New chat`, `Dictate` when dictation is available, and, while anything
  is your concern, a control that hides or shows the cards. Hidden cards leave a bell with the
  number of things waiting on you; working chats show as a spinner and are never counted.
- **Shown or hidden.** Mini starts hidden: only its shortcut opens it. **Show Mini** in the
  account menu at the foot of the rail shows it over other apps, and **Hide Mini** hides it again.
  Settings → General → **Mini** offers the same as `Off`, `When active` (rests on screen only
  while something is your concern) and `Always` (the default once shown); hiding and showing keep
  the last of the two.
- **Cards.** One card per chat or Page Turn that is your concern. A chat you just started from
  Mini comes first until it is under way, so you see it take; then, most urgent first: what needs
  your answer, approval, review or reply; what failed; a chat that finished and you have not seen;
  what is working. Newest first within each. A Page Turn about a chat stands in for that chat's
  own card. Collapsed, the front card shows with the next ones as plates behind it and `N more`
  expands the list; `Show less` collapses it.
- **Composer.** Grows from the dock when **Open Mini** (`Shift+Option+Space`) or `New chat` asks
  for it: the Inbox composer with images, dictation and a chip naming where a new chat works.
  Escape, the shortcut again or a click elsewhere give the keyboard back to the app you were in.
- Mini follows the app's appearance, light or dark. Its surfaces are opaque, with a hairline and
  a shadow, so they read over any app.

## Cards

- A card names its chat or Page, its Project, and one line: the question or approval it waits on;
  else what the chat is doing now; else the start of its last reply.
- The front cards follow their chat live. A question whose answer is one of its options, and an
  approval, answer with one press. A Page Turn ready for review offers `Accept`; a question Turn
  offers its options. Anything that needs writing more or seeing more offers `Open in Nodex`.
- Hovering a card offers `Reply` (a follow-up to the chat, waiting behind a Run that is working,
  or a reply to the Turn), `Stop` while its Run works and you may stop it, and `Dismiss`.
  Dismissing a finished chat marks it read, as opening it would. A dismissed card returns when
  its chat or Turn changes again.
- Clicking a card opens it in Nodex.

## Starting and saving

- `Enter` starts a chat right away where the chip says: the Project chosen last, or no Project.
  It runs on the Inbox's chat Agent, as a chat started from the phone does. The composer folds
  back into the dock and a card shows the chat starting, then working, in front of the others
  until it settles.
- Mini keeps the message until the Host has the chat, also across Mini closing or Nodex quitting,
  and sends it again as the same chat when it comes back. A start that fails says why on its card
  and offers `Try again` and `Edit`, which puts the message back in the composer, after anything
  typed since, with its Project.
- `Cmd/Ctrl+Enter` saves the message to that place's Inbox instead, as the Inbox composer sends
  it, and Mini says `Saved to Inbox` for a moment, with `Open`. A save that does not go through
  waits under the composer with its reason and `Retry`, as in the Inbox.
- The draft, its images and the chosen Project stay until sent, also when Mini is closed. Until
  Mini has read the Projects, the chip names none and nothing is sent, so a chat never starts
  somewhere other than the chip says.
- `Dictate` on the dock opens the composer and starts recording, as its microphone does.

## Notifications

While Mini rests on screen, a chat card replaces system notifications for that chat finishing,
failing, stopping, or asking for approval or an answer. A Page Turn card replaces the system
notification for its exact Page and Turn episode. Other chats and episodes, including Team Space
Turns, follow the usual [Desktop notification rules](desktop-notification-behavior.md). A passing
notice such as `Saved to Inbox` can keep Mini visible. Request resolution still withdraws any
system notification already shown, and chat snooze notifications follow their usual rules.

## Panel presence

- On macOS and Windows, Mini is a floating panel in the personal Space. With Mini off,
  Nodex first creates the panel when you ask for it. When Mini is enabled,
  Nodex prepares its panel at launch.
  **Open Mini** defaults to `Shift+Option+Space` on macOS and `Shift+Alt+Space`
  on Windows. A focused Workbench window runs **Capture to Inbox** instead.
  Change or clear the shortcut in **Settings → Keyboard shortcuts**. The chord
  requires Command/Control or Alt and an ordinary key, must differ from global
  Dictation, and can be held by only one Nodex instance.
- Mini can be hidden, resting without the keyboard, or focused for typing.
  The shortcut toggles keyboard focus. Releasing the keyboard or clicking out
  returns Mini to its resting visibility. A native picker keeps Mini focused
  when the picker closes. On macOS, clicking Mini never activates Nodex or
  brings a Workbench window forward; Mini takes the keyboard without activating
  Nodex and gives it back to the other app when released, and it stays on
  screen when Nodex is hidden. Global Dictation can use a focused Mini composer.
- The Profile keeps whether Mini is shown (off by default) and how a shown Mini
  rests: **Always** (the default) keeps it on screen, **When active** follows
  the activity reported by the panel. A hidden Mini is on screen only while
  focused. A resting Mini steps aside while a Workbench window is focused and
  returns according to the same settings. Opening a Page, Inbox, or chat from Mini brings the personal
  Workbench forward.
- Mini sits a short distance from the edge of its display's work area. Its
  first placement is bottom center. Holding anywhere on Mini outside a text
  field and dragging moves it with the pointer, onto any display; a press that
  travels less than a few pixels stays a click, and the click that ends a move
  is dropped. On release Mini settles at the nearest top or bottom left, center,
  or right position on the display it mostly occupies. Nodex remembers the anchor for each display and uses an available
  display if the last one disappears. The panel stays within the work area when
  display geometry changes. The pointer reaches the app beneath transparent
  areas outside Mini's content.
- Mini stays outside Window Session restoration. If its renderer stops
  unexpectedly, Main prepares a fresh panel for an enabled Mini.

## Companion session

Mini reads and acts through the same Member companion contract as Nodex Mobile, as the
personal Space's Owner on this desktop. Its companion session follows the panel renderer's
lifetime and never registers for push notifications.

Mini reads Projects with `projects.list` and the chat list and unread state with
`chats.list` and `chats.unread`. It starts chats with `chats.start`, watches them with
`chat.open` and `chat.close`, and uses `chat.send`, `chat.stop`, `chat.respond`, and
`chat.markRead` to act in them. A chat with no Agent selected uses the Inbox's chat Agent
and effort. Images imported into the Library attach by their Library File reference.

Mini reads the Library Inbox window and current Page Turns with `inbox.window` and
`inbox.turns`. It uses `inbox.decide` to accept, start, or reply when the Page Turn is the
person's move.
