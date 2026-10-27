# Changelog

## Unreleased

### Fixes

- Stretches open and close from a Tern window connected to omp's machine through Tern remoting, instead of opening a browser tab. The Tern plugin must be installed on both machines.

## 0.3.1 (2026-10-25)

### Fixes

- Opening a stretch whose long form rewrites its short form keeps the short form in view, with the long form after it.
- A stretch with an empty long form shows as plain text instead of a link that opens to nothing.

## 0.3.0 (2026-10-24)

### Features

- Experimental `/stretch section` mode: each section under a heading shows one line, and opening it shows the section in dense form.
- `advisor.md` teaches omp's advisor to read stretch markup instead of flagging it as duplicated text.

### Fixes

- A gist written both before its stretch and as its short form shows once.
- The guide tells the model to write each short form once and ends with an example reply.

## 0.2.0 (2026-10-22)

### Features

- ✦ on a fully open stretch asks the model for more on that section; the answer streams in place and can be deepened again.
- While a ✦ press waits, the star twinkles and counts seconds until the first words arrive.
- ✦ answers come back on resume, reload, session switch and `/tree`, and the next read note reports them.
- Stretches that end on the same word share one `«`.
- tern-awui can press ✦ and shows saved and running answers.

### Fixes

- An answer that is empty, longer than 2,000 characters or would break the reply's markup is refused with a toast.
- A session switch or `/tree` move stops a running ✦ press; a fork keeps it.
- A running press redraws once a second, so a click is less likely to land on a link being replaced.

### Docs

- README section "Ask for more" on ✦ and its cost; the demo GIF and MP4 show a ✦ press.

### Internal

- ✦ presses reuse the main turn's prompt cache and cap output at 1,500 tokens where the provider allows it.

## 0.1.0 (2026-10-21)

First release.

### Features

- The model writes `{{short|long}}` stretches; in Tern each short form is a link that grows its long form in place, and `«` collapses it.
- Nested stretches open one level at a time.
- The next prompt carries a hidden note listing the stretches you opened and the ones you didn't.
- Streaming shows short forms only; aborted stretches and multi-line short forms are drawn open.
- Placeholders without a pipe, such as `{{name}}`, keep their braces.
- `/stretch dense | light | off | status` sets the mode for every omp process; `dense` is the default.
- Tern plugin `omp-stretch` routes stretch clicks to the omp process that drew them and styles stretch links.
- tern-awui shows and opens the same stretches on the phone through the version 1 bridge.
- Install with `omp plugin marketplace add materemias/omp-stretch` and `omp plugin install omp-stretch@omp-stretch`.

### Docs

- README points to [tern-awui](https://github.com/materemias/tern-awui).
- MIT license, including cc-stretch's copyright notice for the ported parser, growth logic and guide text.

### Internal

- Pushing a `vX.Y.Z` tag publishes a GitHub release with that version's changelog section, after the tests pass.

### Known limitations

- omp-stretch patches omp's internal `AssistantMessageComponent.updateContent`, so any omp release can break it. It needs omp 18.11.0 or newer and turns itself off when the method is missing. The supported API is in [#16238](https://github.com/can1357/oh-my-pi/pull/16238), [#16239](https://github.com/can1357/oh-my-pi/pull/16239) and [#16476](https://github.com/can1357/oh-my-pi/pull/16476), not yet merged.
- Clicks work only in Tern; elsewhere stretches are drawn open.
- Open stretches live in memory and close when omp restarts.
