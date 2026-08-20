import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { supabaseConfig } from "@/lib/supabase/config";

/**
 * The server-side session, read from cookies.
 *
 * Everything that needs to know who is asking goes through here rather than through the browser,
 * because the access token is what the Warrant API checks and it must not be handed to client code
 * to forward. The browser never calls the Warrant API; a server component or route handler does,
 * with the token it read here.
 */
export async function supabaseServer(): Promise<SupabaseClient | null> {
  const config = supabaseConfig();
  if (!config) return null;

  const store = await cookies();

  return createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (written) => {
        try {
          for (const { name, value, options } of written) store.set(name, value, options);
        } catch {
          // A Server Component cannot set cookies. That is expected and harmless: the middleware
          // refreshes the session on every request, so the write it could not make here has already
          // been made there.
        }
      },
    },
  });
}

export interface Viewer {
  id: string;
  email?: string;
  /** The bearer token the Warrant API verifies against the provider's published JWKS. */
  accessToken: string;
  expiresAt?: string;
}

/**
 * Who is signed in, or null.
 *
 * The user is read with `getUser()`, which re-checks the token with the provider, rather than from
 * `getSession()`, which trusts what the cookie says. The difference matters: a cookie is
 * attacker-supplied input, and this value decides what a page will show.
 */
export async function currentViewer(): Promise<Viewer | null> {
  const client = await supabaseServer();
  if (!client) return null;

  const { data: verified, error } = await client.auth.getUser();
  if (error || !verified.user) return null;

  const { data: held } = await client.auth.getSession();
  const token = held.session?.access_token;
  if (!token) return null;

  const expiresAt = held.session?.expires_at;

  return {
    id: verified.user.id,
    ...(verified.user.email ? { email: verified.user.email } : {}),
    accessToken: token,
    ...(expiresAt ? { expiresAt: new Date(expiresAt * 1000).toISOString() } : {}),
  };
}
