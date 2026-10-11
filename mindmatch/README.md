# Mindmatch

A minimal PWA for guessing your friends’ first thoughts.

**On iPhone:** open your deployed website in Safari; the Files/Preview HTML viewer is not a reliable way to run this app.

**Deploy:** [SETUP.md](SETUP.md) walks through Supabase, GitHub, and Vercel.

- With two people, both play and the host also moderates. With 3–9 people, choose a separate moderator; the other 2–8 people play.
- 160 original questions in 8 selectable packs, including Germany & the UK.
- 3, 5, 8, 10, 15, or 20 rounds, shuffled without repeats within a session.
- Room codes and invitation links; anonymous sign-in happens in the background.
- Live room notifications, with a 5-second polling fallback.
- Private answers, moderator scoring, rotating guess targets, shared wins.
- Resume the same room after reloading in the same browser.
- Installable metadata/icons for iPhone and Android; an offline recovery page.
- A local demo works without Supabase.

## Run locally

Use Node.js 22.12+ (Node 22 LTS recommended).

```sh
npm ci
npm run dev
```

Open the address printed in the terminal. Use **Try a demo** for a solo preview.
For online rooms, follow SETUP.md to connect Supabase through Vercel. The build automatically reads the integration’s public settings. For local development only, use `.env.local` as described in `.env.example`.

```sh
npm test
npm run build
npm run preview
```

## Files

| File | Purpose |
| --- | --- |
| `src/main.js` | Views, forms, room connection and recovery |
| `src/style.css` | Paper, charcoal and restrained terracotta design |
| `src/backend.js` | Supabase session, RPCs and realtime subscription |
| `src/demo.js` | Solo demonstration with simulated friends |
| `src/questions.js` | All questions and pack definitions |
| `supabase/schema.sql` | Database, access control, game rules and live signal |
| `supabase/two-player-upgrade.sql` | Upgrade an existing database for two-person games |
| `supabase/questions.sql` | Matching database question bank |
| `public/` | PWA manifest, icons, service worker and offline page |
| `tests/` | PostgreSQL, interface and browser integration tests |
| `TESTING.md` | What was checked and the remaining checks |

## How multiplayer works

Vercel serves the frontend. Supabase stores the room and validates all actions.
The database decides when rounds advance; only the moderator can award points. In two-person mode, the host plays and scores both guesses after both submit.
A room row lock serializes competing actions. Duplicate submissions do not replace
an earlier answer, and each mutation includes the round number to reject stale requests.

The only directly readable public table is `mm_signals`, containing a room ID and
revision number. Its row policy restricts it to members. Room details and answers
stay in a private schema. RPCs return only the fields that the current player or
moderator may see. Realtime notifications contain no answers.

The moderator sees all answers only after everyone submits. Players see only their
own answer until the moderator publishes scores. Scores and correct comparisons
then become visible to the whole room.

## Scope

This is a private friends-group app, not a public social network. There is no
permanent friends list, account recovery, chat, or matchmaking. A shared room is
how you connect. The separate moderator does not compete in larger groups. In two-person mode the host competes and also moderates, including scoring their own guess. A disconnected
member can return with the same browser; there is no moderator takeover during a
round. The host can end a stuck session and create another.

Rooms expire after 24 hours. Expiry blocks access; it does not itself delete data.
See SETUP.md for optional cleanup. Do not collect sensitive answers. The operator
of the Supabase project can access its stored data.

The PWA requires internet to play online. It shows an offline recovery page; it
does not run a disconnected multiplayer game or claim native App Store support.

## Changing the questions

Edit `src/questions.js`, then generate the SQL with:

```sh
node scripts/sync-questions.mjs
```

Run the updated `supabase/questions.sql` in Supabase, then redeploy. Keep pack IDs
consistent with the allowed IDs in the database functions if adding a new pack.

## Design reference

Inspired by Anthropic’s restrained paper/ink palette and serif headings, using
system fonts and original app layout, copy, logo and questions. No Anthropic assets
or proprietary fonts are included. Reference: https://www.anthropic.com/
