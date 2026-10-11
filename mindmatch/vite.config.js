import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ""), ...process.env };
  // Only these two public values are allowed into the browser bundle.
  // Never expose SUPABASE_SECRET_KEY, POSTGRES_URL, or all process.env values.
  const url = env.VITE_SUPABASE_URL || env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || "";
  return {
    define: {
      "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(url),
      "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(key),
    },
    server: {
      host: "0.0.0.0", port: 4173, strictPort: true,
      allowedHosts: ["terminal.local"],
    },
  };
});
