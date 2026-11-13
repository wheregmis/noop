import { expect, open, test } from "nsh/test";
import { hubMarkdown, parseHubMarkdown } from "./markdown";

const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |";

test("single newlines become hard breaks", () => {
  expect(hubMarkdown("one\ntwo\n\nthree")).toBe("one  \ntwo\n\nthree");
});

test("table rows keep plain newlines, so the table still parses", () => {
  // a "\" ending the delimiter row would make it an invalid one and the whole table plain text
  expect(hubMarkdown(`Summary\n\n${TABLE}\n\nafter`)).toBe(`Summary\n\n${TABLE}\n\nafter`);
  expect(hubMarkdown("a | b\n:-- | --:\n1 | 2")).toBe("a | b\n:-- | --:\n1 | 2");
});

test("a table right under a line leaves that line without a hard break", () => {
  // the table interrupts the paragraph, and a "\" ending a paragraph shows up literally
  expect(hubMarkdown(`Summary:\n${TABLE}`)).toBe(`Summary:\n${TABLE}`);
});

test("lines around a table still break", () => {
  expect(hubMarkdown(`one\ntwo\n\n${TABLE}\n\nthree\nfour`)).toBe(`one  \ntwo\n\n${TABLE}\n\nthree  \nfour`);
});

test("a rule under a line is not a table", () => {
  expect(hubMarkdown("title | x\n---\ntext")).toBe("title | x  \n---  \ntext");
});

test("a table in a code fence is left alone", () => {
  expect(hubMarkdown(`\`\`\`\n${TABLE}\n\`\`\``)).toBe(`\`\`\`\n${TABLE}\n\`\`\``);
});

const RELEASE = `<details>
<summary>Contributors</summary>

@huacnlee @mizoreww

</details>

<details>
<summary>What's Changed</summary>

* Fix text width in https://github.com/longbridge/gpui-fast/pull/132

</details>`;

test("release notes render HTML disclosures without injected backslashes", () => {
  for (const report of [false, true]) {
    const doc = parseHubMarkdown(RELEASE, report);
    expect(doc.blocks.length).toBe(2);
    expect(doc.blocks[0].type).toBe("details");
    expect(doc.blocks[1].type).toBe("details");
    expect(JSON.stringify(doc)).not.toContain("\\");
    expect(JSON.stringify(doc)).toContain("Contributors");
    expect(JSON.stringify(doc)).toContain("@huacnlee @mizoreww");
  }
});

test("HTML attributes and inline formatting survive without URL rewriting", () => {
  const doc = parseHubMarkdown('<a href="https://example.com/release">Release</a> <strong>ready</strong>', true);
  expect(doc.blocks).toEqual([{ type: "paragraph", content: [
    { type: "link", url: "https://example.com/release", content: [{ type: "text", text: "Release" }] },
    { type: "text", text: " " },
    { type: "strong", content: [{ type: "text", text: "ready" }] },
  ] }]);
});

test("chat still breaks lines and stops bare URLs at Chinese punctuation", () => {
  const doc = parseHubMarkdown("one\ntwo\n\nhttps://github.com/longbridge/nsh/pull/1：说明");
  expect(doc.blocks[0]).toEqual({ type: "paragraph", content: [
    { type: "text", text: "one" }, { type: "break" }, { type: "text", text: "two" },
  ] });
  expect(JSON.stringify(doc)).toContain('"url":"https://github.com/longbridge/nsh/pull/1"');
});

test("block boundaries do not acquire literal backslashes", () => {
  for (const report of [false, true]) {
    const doc = parseHubMarkdown("# Title\ntext\n---\nafter\n\n| a | b |\n|---|---|\n| 1 | 2 |", report);
    expect(JSON.stringify(doc)).not.toContain("\\");
    expect(doc.blocks[0].type).toBe("heading");
    expect(doc.blocks[doc.blocks.length - 1].type).toBe("table");
  }
});

test("report code, escaped punctuation and preformatted HTML remain literal", () => {
  const source = '```text\nC:\\Users\\jason\n<details>\n```\n\n\\*literal\\*\n\n<pre>one\n  two</pre>';
  const doc = parseHubMarkdown(source, true);
  expect(JSON.stringify(doc)).toContain('C:\\\\Users\\\\jason');
  expect(JSON.stringify(doc)).toContain('<details>');
  expect(JSON.stringify(doc)).toContain('*literal*');
  expect(hubMarkdown('```text\nC:\\Users\\jason\n```')).toBe('```text\nC:\\Users\\jason\n```');
});

test("HTML scripts and embedded pages are not rendered as active content", () => {
  const doc = parseHubMarkdown('<div>Hello<script>alert("bad")</script><iframe src="https://example.com">hidden</iframe></div>', true);
  expect(JSON.stringify(doc)).toContain("Hello");
  expect(JSON.stringify(doc)).not.toContain("alert");
  expect(JSON.stringify(doc)).not.toContain("iframe");
  expect(JSON.stringify(doc)).not.toContain("hidden");
});

test("release disclosures can be opened and closed", async () => {
  const app = await open("./fixtures/Markdown.tsx");
  expect(app.shows("Contributors")).toBe(true);
  expect(app.shows("@huacnlee @mizoreww @wabzqem")).toBe(false);
  await app.press("Contributors");
  expect(app.shows("@huacnlee @mizoreww @wabzqem")).toBe(true);
  await app.press("Contributors");
  expect(app.shows("@huacnlee @mizoreww @wabzqem")).toBe(false);
});
