// Repro: one local event must reach the Worker exactly once, even when two flushes overlap.
import { expect, test } from "bun:test";
import { startCloudBridge } from "../src/cloud";
import { appendEvent } from "../src/server";

test("one local event is uploaded exactly once while another flush is in flight", async () => {
  const seen: any[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/events" && req.method === "POST") {
        seen.push(await req.json());
        await gate; // hold the first upload in flight so a second flush can start
        return Response.json({ ok: true });
      }
      if (u.pathname === "/api/host/inbox") return Response.json({ items: [] });
      return Response.json({ ok: true, watchers: 0 });
    },
  });
  const cfg: any = { cloud: { url: `http://127.0.0.1:${server.port}`, poll_seconds: 600 }, server: { token: "t" } };
  startCloudBridge(cfg);
  appendEvent({ from: "test", kind: "notice", text: "one" });
  await Bun.sleep(20);
  appendEvent({ from: "test", kind: "notice", text: "two" }); // mirror hook fires a second flush
  await Bun.sleep(50);
  release();
  await Bun.sleep(300);
  server.stop(true);
  const ids = seen.map((e) => e.text);
  console.log("uploads:", JSON.stringify(ids));
  expect(ids.filter((t) => t === "one")).toHaveLength(1);
  expect(ids).toContain("two");
});

test("a refused upload waits for the poll instead of retrying in a tight loop", async () => {
  let posts = 0;
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/api/events" && req.method === "POST") { posts++; return Response.json({ error: "nope" }, { status: 500 }); }
      if (u.pathname === "/api/host/inbox") return Response.json({ items: [] });
      return Response.json({ ok: true, watchers: 0 });
    },
  });
  const cfg: any = { cloud: { url: `http://127.0.0.1:${server.port}`, poll_seconds: 600 }, server: { token: "t" } };
  startCloudBridge(cfg);
  appendEvent({ from: "test", kind: "notice", text: "refused" });
  await Bun.sleep(600);
  server.stop(true);
  expect(posts).toBe(1); // one attempt; the 3s loop owns the retry
});

