# Changelog

## Unreleased

First version, to be released as 0.1.0.

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
- omp plugin marketplace: the repo is its own marketplace (`.omp-plugin/marketplace.json`, named `omp-stretch`), so `omp plugin marketplace add materemias/omp-stretch` and `omp plugin install omp-stretch@omp-stretch` install it; `package.json` declares `stretch.ts` as the extension.
- Releases: pushing a `vX.Y.Z` tag publishes a GitHub release with that version's section of this changelog as its notes (`.github/workflows/release.yml`), after the tests pass.
- MIT license, including cc-stretch's copyright notice for the ported parser, growth logic and guide text.
- **Known limitation:** patches omp's internal `AssistantMessageComponent.updateContent`, so any omp release can break it. Requires omp 18.11.0 or newer and turns itself off when the module or method is missing. The supported API is in [#16238](https://github.com/can1357/oh-my-pi/pull/16238), [#16239](https://github.com/can1357/oh-my-pi/pull/16239) and [#16476](https://github.com/can1357/oh-my-pi/pull/16476), not yet merged.
- **Known limitation:** clicks work only in Tern; elsewhere stretches are drawn open. Which stretches are open is kept in memory and lost when omp restarts.
