// Chat without the model: where an owner message goes when the chat assistant cannot answer (CLI logged out, quota, timeout).
import { expect, test } from "bun:test";
import * as brain from "../src/brain";
import { localStore, routeWithoutModel } from "../src/brain";
import type { WriteOp } from "../cloud/src/tools";

/** A store whose writes are recorded. The team spoke about T-0259 two minutes ago, which used to decide where a message went. */
function recorder(opts: { amendFails?: boolean } = {}) {
  const did: WriteOp[] = [];
  const st = localStore({
    status: () => ({}),
    feed: () => [{ id: "e1", ts: new Date(Date.now() - 2 * 60_000).toISOString(), from: "keeper@h1", kind: "notice", ref: "T-0259", text: "done" }],
    acts: {
      create_task: async (op) => { did.push(op); return { ok: true, id: "T-0900" }; },
      amend_task: async (op) => { did.push(op); return opts.amendFails ? { ok: false } : { ok: true, id: op.id }; },
    },
  });
  return { st, did };
}

test("no model, no reply target: the message becomes a new task, however recently another task spoke", async () => {
  const { st, did } = recorder();
  const r = await routeWithoutModel(st, { text: "A5还没做完吗", why: new Error("model timeout") });
  expect(did.map((o) => o.tool)).toEqual(["create_task"]); // never amend_task: a finished card is not reopened by recency
  const op = did[0] as Extract<WriteOp, { tool: "create_task" }>;
  expect(op.title).toBe("A5还没做完吗");
  expect(op.details).toContain("model timeout"); // the lead sees why nothing triaged the message
  expect(r).toMatchObject({ ok: true, id: "T-0900", amended: false });
  expect(r.note).toContain("T-0900"); // the owner is told where it went
});

test("no model, a reply to a task: the message goes to that task, and the owner is told", async () => {
  const { st, did } = recorder();
  const r = await routeWithoutModel(st, { text: "还没好吗", reply: "T-0237", why: "Error: model process ended" });
  expect(did).toEqual([{ tool: "amend_task", id: "T-0237", text: "还没好吗" }]);
  expect(r).toMatchObject({ ok: true, id: "T-0237", amended: true });
  expect(r.note).toContain("T-0237");
});

test("no model, the replied-to task cannot be continued: it still becomes a task", async () => {
  const { st, did } = recorder({ amendFails: true });
  const r = await routeWithoutModel(st, { text: "还没好吗", reply: "T-0237", why: "x" });
  expect(did.map((o) => o.tool)).toEqual(["amend_task", "create_task"]);
  expect(r).toMatchObject({ ok: true, id: "T-0900", amended: false });
});

test("no model: the title is the first line of the message, cut to 80 characters", async () => {
  const { st, did } = recorder();
  const nl = String.fromCharCode(10);
  await routeWithoutModel(st, { text: ["first line", "second line"].join(nl), why: "x" });
  await routeWithoutModel(st, { text: "x".repeat(200), why: "x" });
  expect((did[0] as any).title).toBe("first line");
  expect((did[1] as any).title).toHaveLength(80);
});

test("the failure reason is one short line", async () => {
  const { st } = recorder();
  const nl = String.fromCharCode(10);
  const r = await routeWithoutModel(st, { text: "hi", why: new Error(["API Error: 429", "stack line", "y".repeat(500)].join(nl)) });
  expect(r.why).toBe("Error: API Error: 429");
  expect(r.why).not.toContain(nl);
});

test("a message is no longer attached to 'the task the team last spoke about'", () => {
  expect("followUpTarget" in brain).toBe(false);
});
