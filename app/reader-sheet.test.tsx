import { expect, open, test } from "nsh/test";

test("reader sheet resizes, maximizes to the chat width, restores and dismisses", async () => {
  const app = await open("./reader-sheet.fixture.tsx", { width: 1200, height: 800, platform: "macos" });
  await app.press("Open report");
  await app.waitFor("text:Width: 420");
  await app.drag("label:Resize report reader", { x: -100, y: 0 });
  await app.waitFor("text:Width: 520");
  await app.waitFor("text:Saved: 520");
  await app.press("Toggle maximize");
  await app.waitFor("text:Width: 960");
  await app.setViewport(1000, 700);
  await app.waitFor("text:Width: 760");
  await app.press("Toggle maximize");
  await app.waitFor("text:Width: 520");
  await app.keyboard.press("mod+alt+left");
  await app.waitFor("text:Width: 560");
  await app.keyboard.press("Escape");
  await app.waitUntil(() => !app.shows("id:doc-side"));
  await app.press("Open report");
  await app.waitFor("text:Width: 560");
  await app.press("label:Close reader");
  await app.waitUntil(() => !app.shows("id:doc-side"));
});
