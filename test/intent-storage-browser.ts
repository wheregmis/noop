// Explicit platform probe: bun test/intent-storage-browser.ts. Uses a fresh Chrome profile, never the owner's browser data.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const profile = mkdtempSync(join(tmpdir(), "noop-intent-browser-"));
const chrome = process.env.NOOP_TEST_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  if (new URL(req.url).pathname === "/host.js") return new Response(Bun.file(resolve("app/host.js")), { headers: { "Content-Type": "text/javascript" } });
  return new Response('<script type="module">import {createHost} from "/host.js";globalThis.bridge=createHost({hostEvent(){}});</script>', { headers: { "Content-Type": "text/html" } });
} });

async function connect(url: string) {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error("Chrome test connection failed")); });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  let sequence = 0;
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)), receiver = pending.get(message.id);
    if (!receiver) return;
    pending.delete(message.id);
    message.error ? receiver.reject(new Error(message.error.message)) : receiver.resolve(message.result);
  };
  socket.onclose = () => { for (const receiver of pending.values()) receiver.reject(new Error("Chrome test connection closed")); pending.clear(); };
  const request = (method: string, params: unknown = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  return { request, close: () => socket.close(), async evaluate(expression: string) {
    const result = await request("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  } };
}

async function launch() {
  rmSync(join(profile, "DevToolsActivePort"), { force: true });
  const child = Bun.spawn([chrome, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, `http://127.0.0.1:${server.port}/`], { stdout: "ignore", stderr: "ignore" });
  let connection: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    const deadline = Date.now() + 15000;
    let page: { webSocketDebuggerUrl: string } | undefined, port = 0;
    while (!page && Date.now() < deadline) {
      try {
        port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[];
        page = pages.find((item) => item.type === "page");
      } catch { /* Chrome is still starting. */ }
      if (!page) await Bun.sleep(20);
    }
    assert(page, "isolated Chrome did not expose its test page");
    connection = await connect(page.webSocketDebuggerUrl);
    const { evaluate, request } = connection;
    while (!await evaluate("!!globalThis.bridge")) { assert(Date.now() < deadline, "browser host did not load"); await Bun.sleep(20); }
    return { evaluate, async newTab() {
      const target = await request("Target.createTarget", { url: `http://127.0.0.1:${server.port}/` });
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { id: string; webSocketDebuggerUrl: string }[];
      const page = pages.find((item) => item.id === target.targetId); assert(page);
      const tab = await connect(page.webSocketDebuggerUrl), deadline = Date.now() + 5000;
      while (!await tab.evaluate("!!globalThis.bridge")) { assert(Date.now() < deadline, "second browser host did not load"); await Bun.sleep(20); }
      return { evaluate: tab.evaluate, async close() { await request("Target.closeTarget", { targetId: target.targetId }); tab.close(); } };
    }, async close() {
      void request("Browser.close").catch(() => {});
      await Promise.race([child.exited, Bun.sleep(3000)]);
      if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
      connection?.close();
    } };
  } catch (error) {
    connection?.close(); child.kill(); await child.exited; throw error;
  }
}

let browser: Awaited<ReturnType<typeof launch>> | undefined;
try {
  browser = await launch();
  assert.equal(await browser.evaluate(`(async()=>{
    const check=(value,message)=>{if(!value)throw Error(message);}, scope='a'.repeat(64), other='b'.repeat(64);
    check((await bridge.call('pendingRead',{scope})).text===null,'missing document');
    const originalPut=IDBObjectStore.prototype.put;
    let settled=false, observedBeforeCommit=false;
    IDBObjectStore.prototype.put=function(...args){const r=originalPut.apply(this,args);r.addEventListener('success',()=>{observedBeforeCommit=!settled;});return r;};
    try {
      const answer=await bridge.call('pendingWrite',{scope,text:'first',expected:null}).then(value=>{settled=true;return value;});
      check(observedBeforeCommit&&answer.saved===true&&answer.scope===scope,'write ack must follow transaction completion, not request success');
    } finally { IDBObjectStore.prototype.put=originalPut; }
    check((await bridge.call('pendingRead',{scope})).text==='first','committed document');
    check((await bridge.call('pendingRead',{scope:other})).text===null,'session isolation');
    await bridge.call('pendingWrite',{scope,text:'',expected:'first'});check((await bridge.call('pendingRead',{scope})).text==='','empty raw document');
    await bridge.call('pendingWrite',{scope,text:'{malformed',expected:''});check((await bridge.call('pendingRead',{scope})).text==='{malformed','malformed raw document');
    for(const args of [{scope:'../outside',text:'bad',expected:null},{scope,text:42,expected:null},{scope,text:'bad'}]){
      let rejected=false;try{await bridge.call('pendingWrite',args);}catch{rejected=true;}check(rejected,'invalid input must reject');
    }
    IDBObjectStore.prototype.put=function(...args){const r=originalPut.apply(this,args);r.addEventListener('success',()=>this.transaction.abort());return r;};
    try {let rejected=false;try{await bridge.call('pendingWrite',{scope,text:'aborted',expected:'{malformed'});}catch{rejected=true;}check(rejected,'actual transaction abort must reject');}
    finally {IDBObjectStore.prototype.put=originalPut;}
    check((await bridge.call('pendingRead',{scope})).text==='{malformed','aborted write must roll back');
    IDBObjectStore.prototype.put=function(...args){return this.add(...args);};
    try {let rejected=false;try{await bridge.call('pendingWrite',{scope,text:'constraint error',expected:'{malformed'});}catch{rejected=true;}check(rejected,'actual duplicate-key request error must reject');}
    finally {IDBObjectStore.prototype.put=originalPut;}
    check((await bridge.call('pendingRead',{scope})).text==='{malformed','failed request must roll back');
    const originalGet=IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get=function(...args){const r=originalGet.apply(this,args);r.addEventListener('success',()=>this.transaction.abort());return r;};
    try {let rejected=false;try{await bridge.call('pendingRead',{scope});}catch{rejected=true;}check(rejected,'read must wait for transaction completion too');}
    finally {IDBObjectStore.prototype.get=originalGet;}
    return 'transactions passed';
  })()`), "transactions passed");
  const second = await browser.newTab();
  let persisted: string;
  try {
    const read = `(async()=>{return (await bridge.call('pendingRead',{scope:'a'.repeat(64)})).text;})()`;
    const [firstRaw, secondRaw] = await Promise.all([browser.evaluate(read), second.evaluate(read)]);
    assert.equal(firstRaw, "{malformed"); assert.equal(secondRaw, firstRaw);
    const change = (text: string) => `(async()=>{try{await bridge.call('pendingWrite',{scope:'a'.repeat(64),text:${JSON.stringify(text)},expected:${JSON.stringify(firstRaw)}});return {ok:true,text:${JSON.stringify(text)}};}catch(error){return {ok:false,error:String(error)}}})()`;
    const race = await Promise.all([browser.evaluate(change("first tab")), second.evaluate(change("second tab"))]);
    assert.equal(race.filter((value) => value.ok).length, 1, "stale tab must not replace the committed document");
    assert.match(race.find((value) => !value.ok).error, /changed in another window/);
    persisted = race.find((value) => value.ok).text;
    assert.equal(await browser.evaluate(read), persisted); assert.equal(await second.evaluate(read), persisted);
  } finally { await second.close(); }
  await browser.close(); browser = await launch();
  assert.equal(await browser.evaluate(`(async()=>{const result=await bridge.call('pendingRead',{scope:'a'.repeat(64)});return result.text;})()`), persisted);
  console.log("Browser intent storage passed: actual IndexedDB completion, abort/error rollback, raw values, session isolation, two-tab CAS and browser process restart.");
} finally {
  await browser?.close(); server.stop(true); rmSync(profile, { recursive: true, force: true });
}
