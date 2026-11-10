import { describe, expect, open, test } from "nsh/test";

// A page head's hairline reaches thousands of points past the page's edges. A scroll view whose content does not clip
// it reports content that wide, and on iOS a vertical scroll view pans sideways over it (T-9123: a task page shifted
// left on an iPhone, the start of every line cut off and the avatars and names off the screen).
describe("page header", () => {
  test("a page's content clips its head's hairline, so the page is no wider than the screen", async () => {
    const app = await open("./page-header.fixture.tsx", { platform: "ios", width: 390, height: 800 });
    await app.scroll("id:page-clipped", 100);
    await app.scroll("id:page-unclipped", 100);
    await app.waitUntil(() => app.texts().some((t) => /^clipped content [1-9]/.test(t)));
    await app.waitUntil(() => app.texts().some((t) => /^unclipped content [1-9]/.test(t)));
    const width = (name: string) => Number(app.texts().find((t) => t.startsWith(`${name} content `))!.split(" ").pop());
    expect(width("clipped")).toBe(390);
    // without the clip the content reaches past the screen: what the clip is there for
    expect(width("unclipped")).toBeGreaterThan(390);
  });
});
