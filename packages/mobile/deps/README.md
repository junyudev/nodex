# Native dependency builds

`react-native-enriched-markdown-1.2.0.tgz` is a build of
[react-native-enriched-markdown](https://github.com/software-mansion-labs/react-native-enriched-markdown)
with bounded memory while text streams, native link and clipboard behavior, and Android image
alignment. Nodex Mobile uses it to render Markdown with real text selection.

Its install script fetches the pinned native grammars and math renderer. `pnpm-workspace.yaml` allows
that script by this file's path, so renaming the file means updating that entry too.
