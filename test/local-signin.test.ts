import { expect, test } from "bun:test";
import { localSignIn } from "../src/server";

const setup = () => {
  let t = 1_000_000;
  const s = localSignIn("machine-token", () => t);
  return { s, tick: (ms: number) => (t += ms) };
};
const wrong = (code: string) => (code === "000000" ? "000001" : "000000");

test("the code from start signs in once and returns the machine token", () => {
  const { s } = setup();
  expect(s.start("Me@Example.com ")).toEqual({ status: 200, body: { ok: true, delivery: "cli" } });
  const { code, email } = s.pendingCode()!;
  expect(email).toBe("me@example.com");
  expect(code).toMatch(/^\d{6}$/);
  expect(s.verify("me@example.com", code)).toEqual({ status: 200, body: { session: "machine-token" } });
  expect(s.verify("me@example.com", code).status).toBe(401);
  expect(s.pendingCode()).toBeNull();
});

test("rejects a bad email, a wrong code, the wrong address and an expired code", () => {
  const { s, tick } = setup();
  expect(s.start("nope").status).toBe(400);
  expect(s.verify("a@b.c", "123456").status).toBe(401); // nothing pending
  s.start("a@b.c");
  const { code } = s.pendingCode()!;
  expect(s.verify("a@b.c", wrong(code)).status).toBe(401);
  expect(s.verify("other@b.c", code).status).toBe(401);
  tick(10 * 60_000);
  expect(s.pendingCode()).toBeNull();
  expect(s.verify("a@b.c", code).status).toBe(401);
});

test("five wrong tries burn the code, even for the right one after", () => {
  const { s } = setup();
  s.start("a@b.c");
  const { code } = s.pendingCode()!;
  for (let i = 0; i < 5; i++) expect(s.verify("a@b.c", wrong(code)).status).toBe(401);
  expect(s.verify("a@b.c", code).status).toBe(401);
});

test("limits how often codes are issued", () => {
  const { s, tick } = setup();
  s.start("a@b.c");
  expect(s.start("a@b.c").status).toBe(429); // within the resend minute
  for (let i = 0; i < 9; i++) { tick(60_000); expect(s.start("a@b.c").status).toBe(200); }
  tick(60_000);
  expect(s.start("a@b.c").status).toBe(429); // 10 an hour
  tick(3600_000);
  expect(s.start("a@b.c").status).toBe(200);
});
