import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
let db;
const ids = Array.from(
  { length: 11 },
  (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
);
async function as(i, sql, args = []) {
  await db.exec(
    `select set_config('request.jwt.claim.sub','${ids[i]}',false); set role authenticated;`,
  );
  try {
    return (await db.query(sql, args)).rows[0]?.result;
  } finally {
    await db.exec("reset role");
  }
}
const rpc = (i, name, args, casts) =>
  as(
    i,
    `select public.${name}(${casts.map((c, n) => `$${n + 1}::${c}`).join(",")}) as result`,
    args,
  );
let r;
const action = (i, a, p = {}, round = r.round) =>
  rpc(
    i,
    "mm_action",
    [r.id, a, round, JSON.stringify(p)],
    ["uuid", "text", "integer", "jsonb"],
  );
before(async () => {
  db = new PGlite();
  await db.exec(
    `create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$; grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`,
  );
  await db.exec(await fs.readFile("supabase/schema.sql", "utf8"));
  await db.exec(await fs.readFile("supabase/questions.sql", "utf8"));
});
after(() => db.close());
test("160 unique questions and private-table permissions", async () => {
  assert.equal(
    (await db.query("select count(*)::int n from mindmatch.questions")).rows[0]
      .n,
    160,
  );
  await assert.rejects(
    () => as(0, "select * from mindmatch.answers"),
    /permission denied/,
  );
});
test("create, join, duplicate names, outsider and anonymous access", async () => {
  r = await rpc(
    0,
    "mm_create",
    ["Farhan", 3, ["everyday", "germany_uk"]],
    ["text", "integer", "text[]"],
  );
  assert.equal(r.stage, "lobby");
  assert.equal(r.code.length, 8);
  await rpc(1, "mm_join", [r.code, "Maya"], ["text", "text"]);
  await rpc(2, "mm_join", [r.code, "Sam"], ["text", "text"]);
  r = await rpc(3, "mm_join", [r.code, "Alex"], ["text", "text"]);
  assert.equal(r.players.length, 4);
  await assert.rejects(
    () => rpc(4, "mm_join", [r.code, "maya"], ["text", "text"]),
    /name is already/,
  );
  await assert.rejects(
    () => rpc(4, "mm_state", [r.id], ["uuid"]),
    /Room unavailable/,
  );
  await db.exec("set role anon");
  await assert.rejects(
    () => db.query("select public.mm_state($1)", [r.id]),
    /permission denied/,
  );
  await db.exec("reset role");
  const noRows = await as(
    4,
    "select count(*)::int as result from public.mm_signals",
  );
  assert.equal(noRows, 0);
});
test("host controls and minimum players", async () => {
  await assert.rejects(() => action(1, "start"), /Only the host/);
  await assert.rejects(() => action(0, "start"), /two players and a moderator/);
  r = await action(0, "moderator", { id: ids[3] });
  r = await action(0, "start");
  assert.equal(r.stage, "answering");
  assert.equal(r.round, 1);
  assert.ok(r.target);
  await assert.rejects(
    () => rpc(4, "mm_join", [r.code, "Late"], ["text", "text"]),
    /already started/,
  );
});
test("secret answers, retries, stage transitions and moderator permissions", async () => {
  r = await action(0, "submit", { own: "Tea", guess: "Coffee" });
  let mod = await rpc(3, "mm_state", [r.id], ["uuid"]);
  assert.equal(mod.answers.length, 0);
  let other = await rpc(1, "mm_state", [r.id], ["uuid"]);
  assert.equal(other.answers.length, 0);
  r = await action(0, "submit", { own: "Changed", guess: "Changed" });
  assert.equal(r.answers[0].own, "Tea");
  await assert.rejects(
    () => action(1, "score", { id: ids[0], points: 2 }),
    /Only the moderator/,
  );
  await assert.rejects(
    () => action(1, "submit", { own: " ", guess: "X" }),
    /Enter both/,
  );
  await action(1, "submit", { own: "Coffee", guess: "Cake" });
  r = await action(2, "submit", { own: "Cake", guess: "Tea" });
  assert.equal(r.stage, "judging");
  mod = await rpc(3, "mm_state", [r.id], ["uuid"]);
  assert.equal(mod.answers.length, 3);
  other = await rpc(1, "mm_state", [r.id], ["uuid"]);
  assert.equal(other.answers.length, 1);
  await assert.rejects(() => action(3, "publish"), /Score every player/);
  await assert.rejects(
    () => action(3, "score", { id: ids[0], points: 3 }),
    /Points must/,
  );
  for (let i = 0; i < 3; i++)
    await action(3, "score", { id: ids[i], points: i });
  r = await action(3, "publish");
  assert.equal(r.stage, "reveal");
  assert.equal(r.answers.length, 3);
  assert.deepEqual(
    r.players.filter((x) => !x.isModerator).map((p) => p.score),
    [0, 1, 2],
  );
  await assert.rejects(() => action(3, "publish"), /Only the moderator/);
});
test("rotating targets, stale requests, full game and restart", async () => {
  const firstTarget = r.answers.find((a) => a.uid === ids[0]).target;
  r = await action(0, "next");
  const player = await rpc(0, "mm_state", [r.id], ["uuid"]);
  assert.notEqual(player.target, firstTarget);
  await assert.rejects(
    () => action(0, "submit", { own: "late", guess: "late" }, 1),
    /round has changed/,
  );
  for (let round = 2; round <= 3; round++) {
    for (let i = 0; i < 3; i++)
      await action(i, "submit", { own: "A", guess: "B" });
    for (let i = 0; i < 3; i++)
      await action(3, "score", { id: ids[i], points: 2 });
    r = await action(3, "publish");
    r = await action(0, "next");
  }
  assert.equal(r.stage, "finished");
  assert.deepEqual(
    r.players.filter((x) => !x.isModerator).map((p) => p.score),
    [4, 5, 6],
  );
  r = await action(0, "restart");
  assert.equal(r.stage, "lobby");
  assert.ok(r.players.every((p) => p.score === 0));
});
test("question deck uniqueness, removal and expired rooms", async () => {
  r = await action(0, "settings", { rounds: 20, packs: ["food"] });
  r = await action(0, "start");
  const deck = (
    await db.query("select deck from mindmatch.rooms where id=$1", [r.id])
  ).rows[0].deck;
  assert.equal(new Set(deck).size, 20);
  await assert.rejects(
    () => action(0, "remove", { id: ids[1] }),
    /already started/,
  );
  await db.query(
    "update mindmatch.rooms set expires_at=now()-interval '1 second' where id=$1",
    [r.id],
  );
  await assert.rejects(
    () => rpc(0, "mm_state", [r.id], ["uuid"]),
    /Room unavailable/,
  );
});
