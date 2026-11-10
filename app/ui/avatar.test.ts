import { expect, test } from "nsh/test";
import { avatarIdentity, avatarInitials } from "./avatar";

test("account initials: two words give two letters, one word one, nothing a question mark", () => {
  expect(avatarInitials("jason.lee")).toBe("JL");
  expect(avatarInitials("ada_lovelace-byron")).toBe("AL");
  expect(avatarInitials("huacnlee")).toBe("H");
  expect(avatarInitials("zoe@example.com")).toBe("Z");
  expect(avatarInitials("李华")).toBe("李");
  expect(avatarInitials("")).toBe("?");
});

test("an account keeps its identity colors", () => {
  expect(avatarIdentity("huacnlee")).toEqual(avatarIdentity("huacnlee"));
  expect(avatarIdentity("huacnlee").background).toMatch(/^#[0-9a-f]{6}$/);
});
