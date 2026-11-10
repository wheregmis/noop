import { expect, mock, test } from "bun:test";
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";

mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));
mock.module("cloudflare:email", () => ({ EmailMessage: class {} }));
mock.module("cloudflare:sockets", () => ({ connect: () => { throw new Error("No network in this test"); } }));
const workerModule = "../cloud/src/index";
const { default: worker } = await import(workerModule);
const path = "/nsh.0123456789.wasm";
const raw = new TextEncoder().encode("wasm asset bytes ".repeat(100));
const br = brotliCompressSync(raw), gz = gzipSync(raw);

async function request(accept: string, missingBr = false) {
  const fetched: string[] = [];
  const env = { ASSETS: { fetch: async (req: Request) => {
    const pathname = new URL(req.url).pathname;
    fetched.push(pathname);
    if (pathname.endsWith(".br") && missingBr) return new Response("<html>SPA fallback</html>", { headers: { "content-type": "text/html" } });
    const body = pathname.endsWith(".br") ? br : pathname.endsWith(".gz") ? gz : raw;
    return new Response(body, { headers: { "content-type": "application/octet-stream", etag: '"asset"' } });
  } } };
  const response = await worker.fetch(new Request(`https://example.test${path}`, { headers: { "accept-encoding": accept } }), env);
  return { response, fetched, bytes: new Uint8Array(await response.arrayBuffer()) };
}

test("hashed assets preserve precompressed bytes, their type and immutable caching", async () => {
  for (const encoding of ["br", "gzip"] as const) {
    const { response, bytes } = await request(encoding);
    expect(response.headers.get("content-encoding")).toBe(encoding);
    expect(response.headers.get("content-type")).toBe("application/wasm");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("vary")).toBe("accept-encoding");
    expect(bytes).toEqual(new Uint8Array(encoding === "br" ? br : gz));
    expect(new Uint8Array(encoding === "br" ? brotliDecompressSync(bytes) : gunzipSync(bytes))).toEqual(raw);
  }
});

test("encoding negotiation respects exclusions and relative preferences", async () => {
  for (const accept of ["br;q=0, gzip", "br;q=0.2, gzip;q=1", "BR;q=0, GZIP", "br;q=0, *;q=1"]) {
    const { response, fetched } = await request(accept);
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(fetched).toEqual([`${path}.gz`]);
  }
  const { response, bytes } = await request("br;q=0, gzip;q=0");
  expect(response.headers.get("content-encoding")).toBeNull();
  expect(response.headers.get("vary")).toContain("accept-encoding");
  expect(bytes).toEqual(raw);
});

test("a missing compressed asset cannot turn the SPA fallback into encoded wasm", async () => {
  const { response, bytes, fetched } = await request("br, gzip", true);
  expect(response.headers.get("content-encoding")).toBe("gzip");
  expect(fetched).toEqual([`${path}.br`, `${path}.gz`]);
  expect(new Uint8Array(gunzipSync(bytes))).toEqual(raw);
});
