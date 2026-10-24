# Changelog

## 0.3.0 (2026-10-24)

- A gist written twice, once before its stretch (often as a bold lead-in) and again as the stretch's short form, now shows once: the copy in front is dropped. Only a copy that starts its line or a sentence counts, so matching words mid-sentence stay. The prompt now tells the model to write each short form only once, inside its stretch.
- The guide ends with a short example reply: a paragraph and two labelled list items, each gist written once, and the question to the reader outside every stretch.
- Experimental `/stretch section` mode: each section under a heading shows one line, its finding, and opening it shows the section in dense form, each paragraph and list item a gist of its own. Text outside sections, and replies without headings, are written as in dense. Saved like the other modes.
- `advisor.md`: guidance for omp's advisor, imported from `~/.omp/agent/WATCHDOG.md` (see README). Without it the advisor sees raw `{{short|long}}` markup, calls it duplicated text and asks for plain Markdown.

## 0.2.0 (2026-10-22)

- ✦ deepen control: a stretch that is open, with every stretch inside it open too, ends in `✦ «` (stretches ending on the same word share one). A press asks the model for more on that section in a side turn (`runEphemeralTurn`) over the whole conversation, without adding it to the transcript. The answer streams in where it will stay, then becomes a new open `✦` stretch that can hold stretches of its own and be deepened again.
- While a press waits, the ✦ twinkles with a seconds count until the first words arrive. ✦ appears only after its stretch has finished growing. A running press redraws its reply once a second instead of ten times, to make it less likely that a redraw replaces a link while it is being clicked.
- Answers are saved as `omp-stretch.deepen` session entries and come back on resume, reload, session switch and `/tree`. The next read note reports each answer in full; answers saved after the last note that reported answers are reported after a restart too, and never in another session.
- An answer is refused with a toast if, once spliced into the reply, it would close or swallow stretches around it (a stray `}}`, an unclosed fence, a lone backtick pairing with later code), or if it is empty or over 2,000 characters.
- Presses keep the main turn's tools and history so the provider serves the conversation from its prompt cache, cap output at 1,500 tokens where that leaves the request unchanged, and get the full reply (`dedupeReply: false`). A session switch or `/tree` move aborts a running press; a fork keeps it.
- A growing stretch is tracked by key, so a spliced answer never makes the animation grow the wrong stretch. Stretches inside answers are included in the read note.
- Stretches that end on the same word share one `«` instead of stacking a row of them: each click closes the innermost and the next takes its place. ✦ stands before its `«`.
- tern-awui can press ✦ through the version 1 bridge and receive saved answers and running requests. Opening, closing and deepening on the phone use the same pane state and model. The phone renders the twinkle, elapsed seconds and streamed text without an omp-stretch package dependency.
- README: "Ask for more" section on ✦ and its cost, and ✦ in the intro. The demo GIF and MP4 now show a ✦ press: the twinkle and seconds count, the answer streaming in, and a stretch inside the answer opened (`film/` gains a ✦ scene and a fake-model answer for it).

## 0.1.0 (2026-10-21)

First release.

- omp extension `stretch.ts`: the model writes `{{short|long}}` stretches; in Tern each short form is a link that grows its long form in place, with `«` to collapse it. Nested stretches open one level at a time.
- Hidden read note on the next prompt, listing the stretches you opened and the ones you didn't.
- Streaming shows short forms only; aborted stretches and stretches with multi-line short forms are drawn open.
- Literal placeholders without a pipe, such as `{{name}}`, keep their braces. Valid stretches still expand fully outside Tern. A lone backtick is text, not the start of a code span, and a long form may end on its code fence's closing line (```` ```}} ````).
- Replies with a tool call between their text blocks draw each part as its own and number blocks across the whole reply, so clicks, the read note and the phone agree.
- The click directory is `$XDG_RUNTIME_DIR/omp-stretch`, or `/tmp/omp-stretch-$USER` without it, in both the extension and the Tern plugin.
- Stretch keys stay unique when a short form looks like a generated one (`a~2`) or holds ` › `.
- A failed `/stretch` save leaves the mode unchanged. Session switches other than a fork release cached replies, and each read note clears the openings it reported. Prompt-transition tests cover guide swaps, disabling stretches and read notes.
- `/stretch dense | light | off` with argument completion. `dense` is the default. The choice is saved in `~/.omp/agent/stretch.json` and applies to every omp process. `/stretch status` shows this process's mode, the saved mode, whether reply drawing is patched and whether clicks work.
- Tern plugin `omp-stretch` (`tern-plugin/`): routes clicks on `cc-stretch.invalid` links to the omp process that drew them, and styles stretch links as accent text with a dotted underline on hover.
- `bridge` interface (version 1) on `globalThis[Symbol.for("omp-stretch")]`, used by tern-awui to show and open the same stretches on the phone. Stretch keys are the contract: tern-awui keeps its own copy of `stretch-core.ts`, so a change to how keys are built must reach both.
- README points to [tern-awui](https://github.com/materemias/tern-awui), which shows the same stretches on the phone and keeps them in sync with the Tern pane.
- omp plugin marketplace: the repo is its own marketplace (`.omp-plugin/marketplace.json`, named `omp-stretch`), so `omp plugin marketplace add materemias/omp-stretch` and `omp plugin install omp-stretch@omp-stretch` install it; `package.json` declares `stretch.ts` as the extension.
- Releases: pushing a `vX.Y.Z` tag publishes a GitHub release with that version's section of this changelog as its notes (`.github/workflows/release.yml`), after the tests pass.
- MIT license, including cc-stretch's copyright notice for the ported parser, growth logic and guide text.
- **Known limitation:** patches omp's internal `AssistantMessageComponent.updateContent`, so any omp release can break it. Requires omp 18.11.0 or newer and turns itself off when the module or method is missing. The supported API is in [#16238](https://github.com/can1357/oh-my-pi/pull/16238), [#16239](https://github.com/can1357/oh-my-pi/pull/16239) and [#16476](https://github.com/can1357/oh-my-pi/pull/16476), not yet merged.
- **Known limitation:** clicks work only in Tern; elsewhere stretches are drawn open. Which stretches are open is kept in memory and lost when omp restarts.
