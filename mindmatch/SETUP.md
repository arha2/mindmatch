# Mindmatch: easy setup

Use the updated ZIP. No separate Supabase signup and no manual API-key copying.
Vercel creates a linked Supabase account automatically; Supabase still powers the game.

1. Unzip the download and upload the contents of the `mindmatch` folder to GitHub.
2. In Vercel, import that GitHub repository and click **Deploy** (framework: **Vite**).
3. Open your Vercel project → **Storage** → **Create Database** → **Supabase**.
4. Create a new Supabase resource, choose your plan/region, and connect it to this project’s **Production** environment.
5. From that resource, click **Open in Supabase** to enter its dashboard using Vercel.
6. In **SQL Editor → New query**, paste all of `supabase/setup.sql` and click **Run** once.
7. In **Authentication → Sign In / Providers**, enable **Anonymous sign-ins** and save.
8. Back in Vercel, open **Deployments**, choose the latest deployment, and click **Redeploy**.
9. Open your Vercel app link in Safari, create a room, and invite a friend.
10. With two people, tap **Start game**; the host plays and also moderates. With three or more people, pick a moderator before starting.

**On iPhone:** use the website link in Safari, not the downloaded HTML file in Preview; install it with **Share → Add to Home Screen**.

**If Supabase is missing from Storage:** install it at https://vercel.com/marketplace/supabase and connect the new resource to your project.

**If online play says it is not configured:** check the resource is connected to Production, then redeploy again.

**Already ran the earlier SQL files?** Run `supabase/two-player-upgrade.sql` in your existing Supabase project instead of step 6, then deploy the updated frontend. This preserves existing tables, questions, rooms, and answers.

Official integration guide: https://supabase.com/docs/guides/integrations/vercel-marketplace
