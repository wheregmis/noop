import { expect, test } from "bun:test";
import { classify } from "../src/accounts";

test("a gateway 5xx that says 'try again in a moment' is not a quota wall", () => {
  // What Claude Code prints when its API endpoint answers 502: no usage limit anywhere, only a vague retry hint.
  // Counted as quota it puts the account on a one-hour cooldown and moves all its work to the other CLI.
  const out = JSON.stringify({
    type: "result", is_error: true, api_error_status: 502,
    result: "API Error: 502 Bad response. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway.",
  });
  expect(classify(out)).toBeNull();
  expect(classify("Service hiccup, please try again in a few moments")).toBeNull();
  expect(classify("Something went wrong, try again in a bit")).toBeNull();
});

test("quota walls are still recognised, including reset hints that carry a time", () => {
  for (const msg of [
    "You've hit your usage limit. Try again at 3:05 PM.",
    "Rate limit reached, try again in 2h 13m",
    "Come back later: try again in 7 days",
    "Come back later: try again at 3pm",
    "5-hour limit reached ∙ resets 3pm",
    "429 Too Many Requests",
    "Your credit balance is too low to access the API",
    "The server is overloaded",
  ]) expect(classify(msg)).toBe("quota");
});

test("login problems stay auth, and unrelated failures stay unclassified", () => {
  expect(classify("Not logged in · Please run /login")).toBe("auth");
  expect(classify("API Error: 401 unauthorized")).toBe("auth");
  expect(classify("tests failed: 3 of 40")).toBeNull();
});
