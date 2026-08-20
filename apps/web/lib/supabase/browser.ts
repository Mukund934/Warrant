"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseConfig } from "@/lib/supabase/config";

let client: SupabaseClient | null = null;

/**
 * The browser client, which exists for exactly one job: starting the OAuth redirect and ending the
 * session. It never calls the Warrant API - that happens server-side, with a token client code is
 * not given - so nothing here can leak authority into the page.
 *
 * Memoised because `@supabase/ssr` expects one instance per browser context; a second one would
 * race the first over the same cookies.
 */
export function supabaseBrowser(): SupabaseClient | null {
  if (client) return client;
  const config = supabaseConfig();
  if (!config) return null;
  client = createBrowserClient(config.url, config.publishableKey);
  return client;
}
