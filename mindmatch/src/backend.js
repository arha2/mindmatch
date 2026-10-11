import { createClient } from "@supabase/supabase-js";
const url = import.meta.env.VITE_SUPABASE_URL || "";
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || "";
export const configured =
  /^https:\/\/[^/]+\.supabase\.co\/?$/.test(url) &&
  key.length > 20 &&
  !key.includes("YOUR_");
const timeoutFetch = (url, options = {}) =>
  fetch(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(15000),
  });
export const supabase = configured
  ? createClient(url, key, {
      global: { fetch: timeoutFetch },
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    })
  : null;
export async function ensureSession() {
  if (!supabase)
    throw Error(
      "Online play needs the two Supabase settings. You can try the demo now.",
    );
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) {
    const { error } = await supabase.auth.signInAnonymously();
    if (error)
      throw Error(
        error.message.includes("disabled")
          ? "Enable anonymous sign-ins in Supabase Authentication settings."
          : error.message,
      );
  }
}
export async function rpc(name, args) {
  await ensureSession();
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw Error(error.message);
  return data;
}
export function subscribe(room, onChange, onStatus) {
  const channel = supabase
    .channel(`room-${room}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "mm_signals",
        filter: `id=eq.${room}`,
      },
      onChange,
    )
    .subscribe((status) =>
      onStatus(status === "SUBSCRIBED" ? "live" : "syncing"),
    );
  return () => {
    supabase.removeChannel(channel);
  };
}
