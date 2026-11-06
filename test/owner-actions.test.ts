import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ActionSyncError } from "../cloud/src/action-errors";
import { runTool } from "../cloud/src/tools";
import { localStore, think, type Model } from "../src/brain";
import { CODE, DATA, HOME_DIR, P, list, newTask, readDoc, setIdTag, writeDoc } from "../src/core";
import { persistOwnerAction } from "../src/owner-actions";
import { receiveMessage } from "../src/message-receipts";
import { applyCloudOwnerMessage } from "../src/cloud";
import { feed, startServer, type Event } from "../src/server";

const ok = { pull: async () => true, push: async (_: string) => true };
beforeEach(() => {
  for (const dir of ["tasks", "plans", "journal"]) rmSync(P(dir), { recursive: true, force: true });
  rmSync(join(HOME_DIR, "message-receipts"), { recursive: true, force: true });
  mkdirSync(P("journal"), { recursive: true }); mkdirSync(P("agents/lead"), { recursive: true });
  writeFileSync(P("agents/lead/profile.md"), "# Lead\n"); setIdTag("");
});
const event = (): Event => ({ id: crypto.randomUUID(), ts: new Date().toISOString(), from: "owner", kind: "owner", text: "Make a focused change." });

test("owner actions reject false and thrown refreshes before any task or primitive side effect", async () => {
  for (const pull of [async () => false, async () => { throw new Error("offline"); }]) {
    let effects = 0, pushed = 0;
    try {
      await persistOwnerAction(() => { effects++; return { id: newTask("Unchanged"), result: "created" }; }, (v) => v.id,
        { pull, push: async () => { pushed++; return true; } });
      throw new Error("expected refresh failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ActionSyncError);
      expect((error as ActionSyncError).data).toMatchObject({ status: 503, retryable: true });
    }
    expect(effects).toBe(0); expect(pushed).toBe(0); expect(list(P("tasks/inbox"))).toHaveLength(0);
  }
});

test("unconfirmed owner creates preserve their identity and never run the confirmed continuation", async () => {
  for (const push of [async () => false, async () => { throw new Error("offline"); }]) {
    let woken = 0;
    const action = async () => {
      const value = await persistOwnerAction((saved) => {
        const id = newTask("Owner task", "Original request"); saved({ id }); return { ok: true, id, result: "created" };
      }, (v) => `create ${v.id}`, { ...ok, push });
      woken++; return value.result;
    };
    try { await action(); throw new Error("expected partial result"); }
    catch (error) {
      const partial = error as ActionSyncError;
      expect(partial).toBeInstanceOf(ActionSyncError); expect(partial.data).toMatchObject({ status: 503, saved_locally: true, result: "created" });
      const id = String(partial.data.id); expect(partial.message).toContain(id);
      expect(readDoc(P("tasks/inbox", `${id}.md`)).body.trim()).toBe("Original request");
    }
    expect(woken).toBe(0);
  }
  const value = await persistOwnerAction(() => ({ ok: true, id: "T-0001", result: "cancelled" }), () => "cancel", ok);
  expect(value.result).toBe("cancelled");
});

test("post-write failures keep a checkpointed identity and never look retryable", async () => {
  let pushed = 0;
  try {
    await persistOwnerAction((saved) => {
      const id = newTask("Created before journal failure"); saved({ id }); throw new Error("private filesystem detail");
    }, () => "create", { ...ok, push: async () => { pushed++; return true; } });
  } catch (error) {
    expect((error as ActionSyncError).data).toMatchObject({ saved_locally: true, uncertain: true, id: "T-0001" });
    expect((error as ActionSyncError).message).not.toContain("private filesystem");
    expect((error as ActionSyncError).data.retryable).not.toBe(true);
  }
  expect(pushed).toBe(0); expect(list(P("tasks/inbox"))).toHaveLength(1);
});

test("structured sync errors retain the created ID through tools and the owner's corrective reply", async () => {
  const st = localStore({ status: () => ({}), feed: () => [], acts: { create_task: () => persistOwnerAction(() => ({ ok: true, id: newTask("One task") }), (v) => v.id, { ...ok, push: async () => false }) } });
  const result = await runTool(st, "create_task", { title: "One task" });
  expect(result).toMatchObject({ ok: false, data: { id: "T-0001", saved_locally: true, status: 503 } });
  const replies: string[] = [], refs: (string | undefined)[] = [], model: Model = { open: async () => ({ send: async () => JSON.stringify({ reply: "Created it.", calls: [{ tool: "create_task", args: { title: "One more task" } }] }), close() {} }) };
  const outcome = await think({ text: "Create a task" }, st, model, (text, ref) => { replies.push(text); refs.push(ref); });
  expect(outcome.calls[0].ok).toBe(false); expect(replies.at(-1)).toContain("T-0002"); expect(replies.at(-1)).toContain("sync could not be confirmed");
  expect(refs.at(-1)).toBe("T-0002");
});

test("message receipts cache partial creates, reject changed payloads and coalesce concurrent retries", async () => {
  let calls = 0, published = 0;
  const apply = async (_ev: Event, first: boolean) => {
    if (first) published++; calls++;
    await persistOwnerAction(() => ({ id: newTask("One receipt task") }), (v) => v.id, { ...ok, push: async () => false });
  };
  const [first, second] = await Promise.all([receiveMessage("owner", "request-key-1", { text: "create" }, event, apply), receiveMessage("owner", "request-key-1", { text: "create" }, event, apply)]);
  expect(first).toEqual(second); expect(first).toMatchObject({ status: 503, data: { id: "T-0001", saved_locally: true } });
  expect(await receiveMessage("owner", "request-key-1", { text: "create" }, event, apply)).toEqual(first);
  expect((await receiveMessage("owner", "request-key-1", { text: "different" }, event, apply)).status).toBe(409);
  expect(calls).toBe(1); expect(published).toBe(1); expect(list(P("tasks/inbox"))).toHaveLength(1);
});

test("a proven failed refresh retries the same message event without repeating its feed entry", async () => {
  let ready = false, published = 0;
  const applied: string[] = [];
  const apply = async (ev: Event, first: boolean) => {
    if (first) published++; applied.push(ev.id);
    await persistOwnerAction(() => ({ id: newTask("After reconnection") }), (v) => v.id, { ...ok, pull: async () => ready });
  };
  const first = await receiveMessage("owner", "request-key-2", { text: "create" }, event, apply);
  expect(first).toMatchObject({ status: 503, data: { retryable: true } }); expect(list(P("tasks/inbox"))).toHaveLength(0);
  ready = true;
  const retried = await receiveMessage("owner", "request-key-2", { text: "create" }, event, apply);
  expect(retried.status).toBe(200); expect(new Set(applied).size).toBe(1); expect(published).toBe(1); expect(list(P("tasks/inbox"))).toHaveLength(1);
});

test("a process dying after creation leaves an uncertain receipt that a restarted consumer never replays", async () => {
  const child = Bun.spawn([process.execPath, "-e", `
    import {receiveMessage} from ${JSON.stringify(join(CODE, "src/message-receipts.ts"))};
    import {newTask} from ${JSON.stringify(join(CODE, "src/core.ts"))};
    await receiveMessage('crash-owner','request-key-crash',{text:'create'},()=>({id:'crash-event',ts:new Date().toISOString(),from:'owner',kind:'owner',text:'create'}),async()=>{newTask('Created once');process.exit(0)});
  `], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  let repeated = false;
  const result = await receiveMessage("crash-owner", "request-key-crash", { text: "create" }, event, async () => { repeated = true; });
  expect(result).toMatchObject({ status: 503, data: { uncertain: true, message_id: "crash-event" } }); expect(repeated).toBe(false); expect(list(P("tasks/inbox"))).toHaveLength(1);
});

test("a repeated cloud inbox event reuses its durable result and never dispatches twice", async () => {
  const ev = event(); let calls = 0;
  const handle = async () => { calls++; await persistOwnerAction(() => ({ id: newTask("Cloud task") }), (v) => v.id, { ...ok, push: async () => false }); };
  const first = await applyCloudOwnerMessage(ev, handle), replay = await applyCloudOwnerMessage(ev, handle);
  expect(replay).toEqual(first); expect(first).toMatchObject({ status: 503, data: { saved_locally: true, id: "T-0001" } }); expect(calls).toBe(1);
  expect(feed().filter((entry) => entry.id === ev.id)).toHaveLength(1);
});

test("local message HTTP retries retain partial identity without a duplicate create", async () => {
  const server = startServer({ server: { token: "local-message-test", port: 0, host: "127.0.0.1" } }, async () => {
    await persistOwnerAction(() => ({ id: newTask("HTTP task", "Keep this request") }), (v) => v.id, { ...ok, push: async () => false });
  })!;
  const request = () => fetch(`http://127.0.0.1:${server.port}/api/messages`, { method: "POST", headers: { Authorization: "Bearer local-message-test", "Content-Type": "application/json", "Idempotency-Key": "request-http-partial" }, body: JSON.stringify({ text: "Create work" }) });
  try {
    const first = await request(), body = await first.json(); expect(first.status).toBe(503);
    expect(body).toMatchObject({ saved_locally: true, id: "T-0001" });
    const replay = await request(); expect(replay.status).toBe(503); expect(await replay.json()).toEqual(body);
    expect(list(P("tasks/inbox"))).toHaveLength(1); expect(feed().filter((entry) => entry.kind === "owner" && entry.text === "Create work")).toHaveLength(1);
  } finally { server.stop(true); }
});

test("the production inbox loop acknowledges partial actions, safely retries refreshes and reports rejected remote cancellation", async () => {
  for (const scenario of ["partial", "refresh", "remote-cancel"]) {
    mkdirSync(HOME_DIR, { recursive: true });
    const root = mkdtempSync(join(HOME_DIR, "inbox-test-"));
    const script = `
      import {strict as assert} from 'node:assert';
      import {mkdirSync,writeFileSync} from 'node:fs';
      import {P,list,newTask} from ${JSON.stringify(join(CODE, "src/core.ts"))};
      import {persistOwnerAction} from ${JSON.stringify(join(CODE, "src/owner-actions.ts"))};
      import {startCloudBridge} from ${JSON.stringify(join(CODE, "src/cloud.ts"))};
      import {setOwnerTask,setCancelTask,feed} from ${JSON.stringify(join(CODE, "src/server.ts"))};
      const scenario=${JSON.stringify(scenario)}, errors=[]; let calls=0, polls=0, checking=false;
      mkdirSync(P(),{recursive:true});writeFileSync(P('settings.json'),JSON.stringify({configuration:{cloud:{poll_seconds:1}}}));
      mkdirSync(P('agents/lead'),{recursive:true}); mkdirSync(P('journal'),{recursive:true});
      writeFileSync(P('agents/lead/profile.md'),'# Lead'); writeFileSync(P('config.toml'),'[host]\\nname="bridge-test"\\n');
      setOwnerTask(async()=>{calls++; await persistOwnerAction(()=>({id:newTask('Only one owner task')}),v=>v.id,{pull:async()=>scenario!=='refresh'||calls>1,push:async()=>scenario!=='partial'});});
      setCancelTask(async()=> 'running on worker');
      const event={id:'bridge-message-'+scenario,ts:new Date().toISOString(),from:'owner',kind:'owner',text:'Create work'};
      const item=scenario==='remote-cancel'?{seq:1,type:'cancel',id:'T-0044'}:{seq:1,type:'message',event};
      globalThis.fetch=async(input,init)=>{
        const url=new URL(String(input));
        if(url.pathname==='/api/events'){errors.push(JSON.parse(String(init.body)));return Response.json({ok:true});}
        if(url.pathname==='/api/host/inbox'){
          polls++;
          if(Number(url.searchParams.get('after'))>=1){
            if(!checking){checking=true;setTimeout(()=>{
              try{
                if(scenario==='remote-cancel'){assert.equal(calls,0);assert(errors.some(e=>e.text.includes('running on worker')));assert.equal(list(P('tasks/inbox')).length,0);}
                else{assert.equal(calls,scenario==='refresh'?2:1);assert.equal(list(P('tasks/inbox')).length,1);assert.equal(feed().filter(e=>e.id===event.id).length,1);assert(errors.some(e=>e.text.includes(scenario==='refresh'?'Nothing was changed':'Saved T-')));}
                console.log('inbox scenario passed: '+scenario);process.exit(0);
              }catch(e){console.error(e);process.exit(1);}
            },10);}
            return Response.json({items:[]});
          }
          return Response.json({items:[item]});
        }
        return Response.json({ok:true});
      };
      setTimeout(()=>{console.error('inbox fixture timed out');process.exit(1)},5000);
      startCloudBridge({cloud:{url:'http://fixture.invalid',poll_seconds:1},server:{token:'fixture'},host:{name:'bridge-test'}});
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, PATH: "", NOOP_HOME: join(root, "home"), HUB_DATA: join(root, "data"), HUB_CONF: join(root, "noop.toml"), HUB_HOST: "bridge-test", HUB_SYNC: "local" }, stdout: "pipe", stderr: "pipe" });
    try {
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(await child.exited).toBe(0);
      expect((await output)[0]).toContain(`inbox scenario passed: ${scenario}`);
    } finally { if (child.exitCode === null) { child.kill(); await child.exited; } rmSync(root, { recursive: true, force: true }); }
  }
});
