import { expect, test } from "nsh/test";
import { hubMarkdown } from "./markdown";

const TABLE = "| a | b |\n|---|---|\n| 1 | 2 |";

test("single newlines become hard breaks", () => {
  expect(hubMarkdown("one\ntwo\n\nthree")).toBe("one\\\ntwo\n\nthree");
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
  expect(hubMarkdown(`one\ntwo\n\n${TABLE}\n\nthree\nfour`)).toBe(`one\\\ntwo\n\n${TABLE}\n\nthree\\\nfour`);
});

test("a rule under a line is not a table", () => {
  expect(hubMarkdown("title | x\n---\ntext")).toBe("title | x\\\n---\\\ntext");
});

test("a table in a code fence is left alone", () => {
  expect(hubMarkdown(`\`\`\`\n${TABLE}\n\`\`\``)).toBe(`\`\`\`\n${TABLE}\n\`\`\``);
});
