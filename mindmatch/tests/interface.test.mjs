import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { JSDOM } from "jsdom";
import { build } from "esbuild";
import { PGlite } from "@electric-sql/pglite";
let db,
  bundle,
  queue = Promise.resolve(),
  windows = [];
const ids = Array.from(
  { length: 5 },
  (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
);
const signatures = {
  mm_create: ["p_name", "p_rounds", "p_packs"],
  mm_join: ["p_code", "p_name"],
  mm_state: ["p_room"],
  mm_action: ["p_room", "p_action", "p_round", "p_payload"],
};
before(async () => {
  db = new PGlite();
  await db.exec(
    `create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`,
  );
  await db.exec(await fs.readFile("supabase/schema.sql", "utf8"));
  await db.exec(await fs.readFile("supabase/questions.sql", "utf8"));
  bundle = (
    await build({
      entryPoints: ["src/main.js"],
      bundle: true,
      write: false,
      format: "iife",
      loader: { ".css": "empty" },
      define: {
        "import.meta.env.VITE_SUPABASE_URL": '"https://test.supabase.co"',
        "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY":
          '"sb_publishable_test_only_not_a_real_key"',
        "import.meta.env.PROD": "false",
      },
    })
  ).outputFiles[0].text;
});
after(async () => {
  windows.forEach((w) => w.close());
  await queue;
  await db.close();
});
function createWindow(i) {
  const dom = new JSDOM(
    '<header><div id="header-actions"></div></header><div id="network" hidden></div><main id="app"></main><div id="toast" hidden></div><dialog id="modal"></dialog>',
    {
      url: "https://mindmatch.test/",
      runScripts: "dangerously",
      pretendToBeVisual: true,
    },
  );
  const w = dom.window;
  w.scrollTo = () => {};
  w.structuredClone = structuredClone;
  w.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  w.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  w.AbortSignal = AbortSignal;
  w.Response = Response;
  w.Headers = Headers;
  w.Request = Request;
  w.BroadcastChannel = undefined;
  w.WebSocket = class extends w.EventTarget {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 3;
    close() {}
    send() {}
  };
  const user = {
    id: ids[i],
    aud: "authenticated",
    role: "authenticated",
    is_anonymous: true,
    app_metadata: {},
    user_metadata: {},
  };
  w.fetch = (url, opts = {}) => {
    const job = queue.then(async () => {
      const path = new URL(url).pathname;
      if (path.startsWith("/auth/")) {
        const token =
          Buffer.from('{"alg":"none"}').toString("base64url") +
          "." +
          Buffer.from(
            JSON.stringify({
              sub: ids[i],
              aud: "authenticated",
              exp: Math.floor(Date.now() / 1000) + 3600,
            }),
          ).toString("base64url") +
          ".signature";
        return new Response(
          JSON.stringify({
            access_token: token,
            refresh_token: "test",
            token_type: "bearer",
            expires_in: 3600,
            user,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      const fn = path.split("/").pop(),
        body = JSON.parse(opts.body || "{}");
      try {
        await db.exec(
          `select set_config('request.jwt.claim.sub','${ids[i]}',false);set role authenticated;`,
        );
        const args = signatures[fn].map((k) =>
          k === "p_payload" ? JSON.stringify(body[k]) : body[k],
        );
        const result = (
          await db.query(
            `select public.${fn}(${args.map((_, i) => "$" + (i + 1)).join(",")}) as result`,
            args,
          )
        ).rows[0].result;
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(
          JSON.stringify({ message: e.message, code: "P0001" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      } finally {
        await db.exec("reset role");
      }
    });
    queue = job.catch(() => {});
    return job;
  };
  w.eval(bundle);
  windows.push(w);
  return w;
}
const input = (w, id, value) => {
  const el = w.document.getElementById(id);
  assert.ok(el, "Input " + id + " exists");
  el.value = value;
  el.dispatchEvent(new w.Event("input", { bubbles: true }));
};
const click = (w, action, selector = "") => {
  const el = w.document.querySelector(`[data-action="${action}"]${selector}`);
  assert.ok(el, "Action " + action + " exists");
  assert.ok(!el.disabled, "Action " + action + " enabled");
  el.click();
};
const submit = (w, id) =>
  w.document
    .getElementById(id)
    .dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
async function until(fn, label) {
  for (let i = 0; i < 160; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("Timed out: " + label);
}
const text = (w) => w.document.getElementById("app").textContent;
function refresh(w) {
  w.document.dispatchEvent(new w.Event("visibilitychange"));
}
test("complete 4-person online interface through 3 rounds against PostgreSQL", async () => {
  const [host, maya, sam, mod] = [0, 1, 2, 3].map(createWindow);
  input(host, "host-name", "Farhan");
  click(host, "round", '[data-value="3"]');
  await until(
    () => !host.document.querySelector('[data-action="round"]').disabled,
    "round selection",
  );
  submit(host, "create-form");
  await until(() => text(host).includes("Your room"), "create");
  const code = host.document.querySelector(".room-code").textContent;
  for (const [w, name] of [
    [maya, "Maya"],
    [sam, "Sam"],
    [mod, "Alex"],
  ]) {
    input(w, "join-name", name);
    input(w, "code", code);
    submit(w, "join-form");
    await until(() => text(w).includes("Your room"), "join " + name);
  }
  refresh(host);
  await until(
    () => host.document.querySelectorAll("#moderator option").length === 5,
    "live lobby",
  );
  const select = host.document.querySelector("#moderator");
  select.value = ids[3];
  select.dispatchEvent(new host.Event("change", { bubbles: true }));
  await until(
    () => !host.document.querySelector('[data-action="start"]').disabled,
    "moderator assignment",
  );
  click(host, "start");
  for (let round = 1; round <= 3; round++) {
    for (const w of [host, maya, sam, mod]) refresh(w);
    await until(() => host.document.querySelector("#own"), "round started");
    for (const [i, w] of [host, maya, sam].entries()) {
      await until(() => w.document.querySelector("#own"), "answer input");
      input(w, "own", ["Tea", "Coffee", "Cake"][i]);
      input(w, "guess", ["Coffee", "Cake", "Tea"][i]);
      submit(w, "answer-form");
      await until(() => !w.document.querySelector("#own"), "answer submitted");
    }
    refresh(mod);
    refresh(host);
    await until(
      () => mod.document.querySelectorAll(".score-buttons").length === 3,
      "moderator answers",
    );
    await until(
      () => text(host).includes("With the moderator"),
      "player waiting",
    );
    assert.equal(host.document.querySelectorAll(".comparison").length, 0);
    for (let i = 0; i < 3; i++) {
      click(mod, "score", `[data-id="${ids[i]}"][data-points="2"]`);
      await until(
        () => !mod.document.querySelector('[data-action="score"]').disabled,
        "score saved",
      );
    }
    click(mod, "publish");
    await until(() => text(mod).includes("Round scores"), "revealed");
    refresh(host);
    await until(
      () => host.document.querySelector('[data-action="next"]'),
      "next button",
    );
    click(host, "next");
    await until(() => !text(host).includes("Round scores"), "next round");
  }
  await until(() => text(host).includes("JOINT WINNERS"), "final scores");
  assert.equal(
    host.document.querySelector(".winner .score").textContent,
    "6 points",
  );
  click(host, "restart");
  await until(() => text(host).includes("Your room"), "restart");
  assert.equal(host.document.querySelectorAll(".person").length, 4);
});
test("demo, pack selection, input validation and moderator controls", async () => {
  const w = createWindow(4);
  click(w, "packs");
  assert.equal(w.document.querySelectorAll("input[name=pack]").length, 8);
  click(w, "save-packs");
  await until(() => !w.document.querySelector("#modal").open, "save packs");
  click(w, "demo");
  click(w, "start");
  await until(() => w.document.querySelector("#own") && !w.document.querySelector("#answer-form button").disabled, "demo start");
  input(w, "own", " ");
  input(w, "guess", "Tea");
  submit(w, "answer-form");
  await until(() => text(w).includes("Enter both answers."), "blank rejected");
  input(w, "own", "Coffee");
  submit(w, "answer-form");
  await until(() => text(w).includes("With the moderator") && !w.document.querySelector('[data-action="judge"]').disabled, "demo submitted");
  click(w, "judge");
  assert.equal(w.document.querySelectorAll(".score-buttons").length, 3);
  assert.ok(w.document.querySelector("[data-action=publish]").disabled);
  for (const id of ["p0", "p1", "p2"]) {
    click(w, "score", `[data-id="${id}"][data-points="1"]`);
    await until(
      () => !w.document.querySelector("[data-action=score]").disabled,
      "demo score",
    );
  }
  click(w, "publish");
  await until(() => text(w).includes("Round scores"), "demo reveal");
});
