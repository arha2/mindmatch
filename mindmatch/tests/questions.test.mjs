import { test } from "node:test";
import assert from "node:assert/strict";
import { questions, packs, chooseQuestions } from "../src/questions.js";
test("eight packs of twenty distinct questions", () => {
  assert.equal(Object.keys(packs).length, 8);
  assert.equal(questions.length, 160);
  assert.equal(new Set(questions.map((q) => q.text)).size, 160);
  assert.ok(Object.values(packs).every((p) => p.questions.length === 20));
});
test("selected packs only; no repeated question in a session", () => {
  for (let i = 0; i < 50; i++) {
    const deck = chooseQuestions(["germany_uk", "friends"], 20);
    assert.equal(deck.length, 20);
    assert.equal(new Set(deck.map((q) => q.id)).size, 20);
    assert.ok(deck.every((q) => ["germany_uk", "friends"].includes(q.pack)));
  }
});
