/**
 * Whether this deployment has an identity provider at all.
 *
 * Both values are browser-visible by design and by necessity: they are inlined into the client
 * bundle and cannot be recalled, which is exactly why only these two ever earn the `NEXT_PUBLIC_`
 * prefix. `WARRANT_API_URL` must never gain one — it is read in server code only, and the browser
 * never talks to the Warrant API directly.
 *
 * Absent means sign-in is switched off, and that is a supported deployment rather than a broken one.
 * The demonstrator, the verifier and every public page work without it, the same way the assistant
 * is absent without a model. A build must never fail because an optional credential is missing.
 */
export interface SupabaseConfig {
  url: string;
  publishableKey: string;
}

export function supabaseConfig(): SupabaseConfig | null {
  // Read as two whole expressions rather than through a helper: Next inlines `process.env.NEXT_PUBLIC_*`
  // at build time by matching the literal text, so anything cleverer than this silently yields
  // `undefined` in the browser bundle.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) return null;
  return { url, publishableKey };
}

export const signInConfigured = (): boolean => supabaseConfig() !== null;

/**
 * The one path Supabase must be told about. Everything that needs the callback URL derives it from
 * here, so the value configured in the dashboard can be read off the code rather than guessed —
 * and so it cannot drift from the route that actually exists.
 */
export const CALLBACK_PATH = "/auth/callback";

export function callbackUrl(origin: string): string {
  return new URL(CALLBACK_PATH, origin).toString();
}

/** Where the console sends someone who arrived without asking for anywhere in particular. */
export const DEFAULT_LANDING = "/console";

/**
 * A `next=` parameter, reduced to something that can only be a path on this origin.
 *
 * The callback redirects to whatever this returns, and the parameter survives a round trip through
 * Google — so it is attacker-supplied input that this application will send a freshly signed-in
 * person to. An absolute URL here is an open redirect, and a protocol-relative `//evil.example` is
 * the same thing wearing a path's clothes.
 */
export function safeRedirectPath(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_LANDING;
  // Anything but a plain, single-slash path is refused rather than repaired. `\\` is included
  // because some browsers normalise a backslash to a forward slash before resolving.
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return DEFAULT_LANDING;
  return raw;
}
