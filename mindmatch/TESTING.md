# Verification report

Tested on 26 September 2026. See the explicit limitations below before treating
this as a production sign-off.

## Passed here

- Production Vite build.
- Vercel Marketplace public variables map to the frontend without exposing secret keys.
- The single `supabase/setup.sql` installs the schema and all 160 questions.
- 160 distinct questions, eight packs of 20.
- Repeated shuffled draws use only selected packs and contain no duplicates.
- Full SQL schema and seed execute in PGlite, a PostgreSQL engine compiled to WASM.
- Four separate authenticated identities create/join a room.
- Duplicate names and late joins are rejected.
- Unauthenticated callers cannot execute game RPCs.
- Nonmembers cannot read rooms or their revision signals.
- Private answer tables are inaccessible to frontend roles.
- Only the host can configure/start a game.
- A moderator plus at least two players is required.
- Answers are hidden from other players and from the moderator before judging.
- Players cannot score themselves. Points outside 0–2 are rejected.
- Repeated submissions preserve the original answer.
- All players must be scored before publication.
- Targets rotate, old-round submissions are rejected, and points accumulate once.
- Full multi-round games, results and restarting.
- Expired rooms are inaccessible.
- The real interface code runs through a four-person, three-round game against
  those SQL functions in jsdom, including joins, moderator selection, submission,
  scoring, tied winners and restart.
- Demo UI, pack selection, blank-answer validation, moderator scoring and reveal.

Run the checks:

```sh
npm ci
npm test
npm run build
```

`npm test` contains 12 test groups; each group checks multiple assertions.

## Not verified here

**No real-browser screenshots were captured.** Chromium could not launch in the
execution environment; its browser preview was also unavailable. WebKit's required
system libraries were unavailable. The jsdom tests execute the interface and its
behaviour but do not render pixels, measure layout, or prove browser compatibility.

Consequently, the responsive layout, physical iPhone/Android installation,
service-worker offline page, real Safari behaviour, and actual device screenshots
still need browser/device checks. The app includes the corresponding CSS, manifest,
icons and recovery code, but implementation is not the same as verification.

No live Supabase project or Vercel deployment was connected. Authentication HTTP
responses are simulated in the test harness, while game state/permissions are
executed by real PostgreSQL. Hosted anonymous authentication, Realtime WebSocket
connectivity, network interruptions, and region-to-region behaviour need the
three-device smoke test in SETUP.md.

The database checks do not constitute a load test or an independent security audit.
No software package can guarantee zero bugs or uninterrupted network service.

## Browser suite included for a supported machine

```sh
npx playwright install --with-deps chromium webkit
npm run test:browser
```

The browser harness starts a local Vite server, simulates Supabase auth/HTTP,
executes RPCs against PGlite, and disables WebSockets to exercise the polling
fallback. It is intended to cover desktop, iPhone/Android viewport layouts,
room joins, scoring, a complete game, draft recovery, a lost submission response,
offline/reconnect and a WebKit demo. It saves screenshots to `screenshots/`.

This suite was **included but could not execute here**; its success is not claimed.
It is not a substitute for connecting your actual Supabase project.

## Quick visual review without deployment

Open `preview.html` in a desktop browser and choose **Try a demo**. It is a
self-contained build of the app with online configuration deliberately absent.
Use the browser's responsive mode to inspect smaller viewports, or run the app on
a local web server to view it from a phone. Online play and PWA installation should
be checked on your deployed HTTPS URL.

## Image previews

The accompanying PNGs are static renders of the app’s DOM and CSS, with form controls and responsive CSS adapted for the HTML renderer. They are visual previews, not browser/device screenshots or proof of Safari layout behaviour. Browser capture was retried and remained unavailable.
