import { mount, View } from "nsh";
import { TextView } from "nsh/base";
import { parseHubMarkdown } from "../markdown";
const source = `# Release notes

## Fixes

- Correct width of truncated text (#132)

<details>
<summary>Contributors</summary>

@huacnlee @mizoreww @wabzqem

</details>

<details>
<summary>What's Changed</summary>

- Fix text width in https://github.com/longbridge/gpui-fast/pull/132

</details>`;
function App() { return <View style={{ padding: 24 }}><TextView document={parseHubMarkdown(source, true)} selectable /></View>; }
mount(App);
