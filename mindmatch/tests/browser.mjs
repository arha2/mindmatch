// Integration harness: real browser + real PostgreSQL engine (PGlite).
// Auth/HTTP transport is simulated; this does not assert a hosted Supabase connection.
import { chromium, webkit, devices } from "@playwright/test";
import { PGlite } from "@electric-sql/pglite";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
const db = new PGlite();
await db.exec(
  `create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;`,
);
await db.exec(await fs.readFile("supabase/schema.sql", "utf8"));
await db.exec(await fs.readFile("supabase/questions.sql", "utf8"));
const server = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "4173"],
  {
    env: {
      ...process.env,
      VITE_SUPABASE_URL: "https://test.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_only_not_a_real_key",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
await new Promise((resolve, reject) => {
  server.stdout.on("data", (d) => {
    if (String(d).includes("4173")) resolve();
  });
  server.on("error", reject);
  server.on("exit", (c) => reject(Error("Server exited " + c)));
});
await fs.mkdir("screenshots", { recursive: true });
let browser,
  queue = Promise.resolve(),
  clients = [];
const errors = [];
const signatures = {
  mm_create: ["p_name", "p_rounds", "p_packs"],
  mm_join: ["p_code", "p_name"],
  mm_state: ["p_room"],
  mm_action: ["p_room", "p_action", "p_round", "p_payload"],
};
async function client(i, options = {}) {
  const uid = `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
  const ctx = await browser.newContext(options);
  await ctx.routeWebSocket("wss://test.supabase.co/**", (ws) => ws.close());
  let fail = false;
  await ctx.route("https://test.supabase.co/**", (route) => {
    const job = queue.then(async () => {
      const url = new URL(route.request().url());
      const headers = {
        "access-control-allow-origin": "*",
        "content-type": "application/json",
      };
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 200, headers });
        return;
      }
      if (url.pathname.startsWith("/auth/")) {
        const token =
          Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url") +
          "." +
          Buffer.from(
            JSON.stringify({
              sub: uid,
              aud: "authenticated",
              role: "authenticated",
              exp: Math.floor(Date.now() / 1000) + 3600,
            }),
          ).toString("base64url") +
          ".signature";
        await route.fulfill({
          json: {
            access_token: token,
            refresh_token: "test-" + uid,
            expires_in: 3600,
            token_type: "bearer",
            user: {
              id: uid,
              aud: "authenticated",
              role: "authenticated",
              is_anonymous: true,
              app_metadata: {},
              user_metadata: {},
              created_at: new Date().toISOString(),
            },
          },
        });
        return;
      }
      const fn = url.pathname.split("/").pop();
      const body = route.request().postDataJSON();
      try {
        if (!signatures[fn]) throw Error("Unexpected request " + fn);
        await db.exec(
          `select set_config('request.jwt.claim.sub','${uid}',false);set role authenticated;`,
        );
        const args = signatures[fn].map((k) =>
          k === "p_payload" ? JSON.stringify(body[k]) : body[k],
        );
        const result = (
          await db.query(
            `select public.${fn}(${args.map((_, i) => "$" + (i + 1)).join(",")}) as value`,
            args,
          )
        ).rows[0].value;
        if (fail && body.p_action === "submit") {
          fail = false;
          await route.abort("failed");
        } else await route.fulfill({ status: 200, headers, json: result });
      } catch (err) {
        await route.fulfill({
          status: 400,
          headers,
          json: { message: err.message, code: "P0001" },
        });
      } finally {
        await db.exec("reset role");
      }
    });
    queue = job.catch(() => {});
    return job;
  });
  const page = await ctx.newPage();
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto("http://127.0.0.1:4173");
  const c = {
    ctx,
    page,
    failNextSubmit() {
      fail = true;
    },
  };
  clients.push(c);
  return c;
}
async function wait(page, text) {
  await page
    .getByText(text, { exact: true })
    .first()
    .waitFor({ timeout: 15000 });
}
async function screenshot(page, file) {
  await page.screenshot({ path: "screenshots/" + file, fullPage: true });
}
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
  });
  const host = await client(0, { viewport: { width: 1440, height: 1000 } }),
    maya = await client(1, {
      ...devices["iPhone 13"],
      defaultBrowserType: undefined,
    }),
    sam = await client(2, {
      ...devices["Pixel 7"],
      defaultBrowserType: undefined,
    }),
    mod = await client(3, { viewport: { width: 1280, height: 900 } });
  await screenshot(host.page, "desktop-home.png");
  await screenshot(maya.page, "mobile-home.png");
  await host.page.locator("#host-name").fill("Farhan");
  await host.page.getByRole("button", { name: "3", exact: true }).click();
  await host.page
    .getByRole("button", { name: "Create room", exact: true })
    .click();
  await wait(host.page, "Your room");
  const code = await host.page.locator(".room-code").textContent();
  for (const [c, name] of [
    [maya, "Maya"],
    [sam, "Sam"],
    [mod, "Alex"],
  ]) {
    await c.page.locator("#join-name").fill(name);
    await c.page.locator("#code").fill(code);
    await c.page
      .getByRole("button", { name: "Join room", exact: true })
      .click();
    await wait(c.page, "Your room");
  }
  await host.page
    .locator("#moderator option")
    .filter({ hasText: "Alex" })
    .waitFor({ state: "attached", timeout: 15000 });
  await host.page.locator("#moderator").selectOption({ label: "Alex" });
  await screenshot(host.page, "desktop-lobby.png");
  await host.page
    .getByRole("button", { name: "Start game", exact: true })
    .click();
  for (let round = 1; round <= 3; round++) {
    for (const c of [host, maya, sam])
      await c.page.locator("#own").waitFor({ timeout: 15000 });
    if (round === 1) {
      await screenshot(host.page, "desktop-round.png");
      await screenshot(maya.page, "mobile-round.png");
      await host.page.locator("#own").fill("My draft");
      await host.page.reload();
      await host.page.locator("#own").waitFor();
      assert.equal(await host.page.locator("#own").inputValue(), "My draft");
    }
    for (const [i, c] of [host, maya, sam].entries()) {
      await c.page.locator("#own").fill(["Tea", "Coffee", "Cake"][i]);
      await c.page.locator("#guess").fill(["Coffee", "Cake", "Tea"][i]);
      await c.page
        .getByRole("button", { name: "Submit answers", exact: true })
        .click();
    }
    await mod.page
      .getByRole("button", { name: "2 · Match", exact: true })
      .first()
      .waitFor({ timeout: 15000 });
    await wait(host.page, "With the moderator");
    assert.equal(await host.page.locator(".comparison").count(), 0);
    for (const group of await mod.page.locator(".score-buttons").all())
      await group
        .getByRole("button", { name: "2 · Match", exact: true })
        .click();
    if (round === 1) await screenshot(mod.page, "desktop-moderator.png");
    await mod.page
      .getByRole("button", { name: "Reveal scores", exact: true })
      .click();
    await host.page
      .getByRole("button", {
        name: round === 3 ? "Final scores" : "Next round",
        exact: true,
      })
      .waitFor({ timeout: 15000 });
    await host.page
      .getByRole("button", {
        name: round === 3 ? "Final scores" : "Next round",
        exact: true,
      })
      .click();
  }
  await wait(host.page, "JOINT WINNERS");
  await screenshot(host.page, "desktop-results.png");
  assert.equal(
    await host.page.locator(".winner .score").textContent(),
    "6 points",
  );
  for (const c of clients) {
    assert.ok(
      await c.page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "No horizontal overflow",
    );
  }
  await host.page
    .getByRole("button", { name: "Play again", exact: true })
    .click();
  await wait(host.page, "Your room");
  await host.page
    .getByRole("button", { name: "Start game", exact: true })
    .click();
  await host.page.locator("#own").fill("Stored despite a lost response");
  await host.page.locator("#guess").fill("Coffee");
  host.failNextSubmit();
  await host.page
    .getByRole("button", { name: "Submit answers", exact: true })
    .click();
  await wait(host.page, "Answers submitted");
  assert.equal(
    (await db.query("select count(*)::int n from mindmatch.answers")).rows[0].n,
    1,
  );
  await host.ctx.setOffline(true);
  await wait(
    host.page,
    "Connection lost. Your answers are kept on this device. Reconnecting…",
  );
  await host.ctx.setOffline(false);
  await wait(host.page, "Connected");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: Chromium desktop + iPhone/Android viewport, 4 clients, room joins, moderator assignment, 3 rounds, ties, restart, hidden answers, draft reload, lost submit response, offline/reconnect, no page errors, no horizontal overflow.",
  );
  await browser.close();
  browser = null;
  // WebKit exercises the local demo with mobile touch layout; no claim of physical iOS testing.
  try {
    browser = await webkit.launch({ headless: true });
    const c = await client(7, {
      ...devices["iPhone 13"],
      defaultBrowserType: undefined,
    });
    await c.page
      .getByRole("button", { name: "Try a demo", exact: true })
      .click();
    await c.page
      .getByRole("button", { name: "Start game", exact: true })
      .click();
    await c.page.locator("#own").fill("Tea");
    await c.page.locator("#guess").fill("Coffee");
    await c.page
      .getByRole("button", { name: "Submit answers", exact: true })
      .click();
    await c.page
      .getByRole("button", { name: "Open moderator view", exact: true })
      .click();
    assert.equal(await c.page.locator(".score-buttons").count(), 3);
    await screenshot(c.page, "mobile-moderator.png");
    console.log("PASS: WebKit mobile demo through moderator view.");
  } catch (err) {
    console.error("WebKit test failed:", err.message);
    throw err;
  }
} finally {
  await browser?.close();
  server.kill("SIGTERM");
  await queue;
  await db.close();
}
