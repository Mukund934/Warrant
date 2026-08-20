import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { supabaseConfig } from "@/lib/supabase/config";

/**
 * Refreshes the session cookie on every request that could render a signed-in page.
 *
 * Named `proxy` because Next 16 renamed the convention; the file is the same idea it always was.
 *
 * Without this, an access token expires and the next server render sees a signed-out user even
 * though the browser still holds a valid refresh token — the session appears to end at an arbitrary
 * moment rather than when it actually does. A Server Component cannot write cookies, so this is the
 * only place the refreshed pair can be persisted.
 *
 * It authorises nothing. Deciding what a signed-in person may do is the Warrant API's job, and the
 * API re-checks the token against the provider's published JWKS whatever this file did.
 */
export default async function proxy(request: NextRequest) {
  const config = supabaseConfig();
  // No provider configured: every page is public and there is no session to refresh.
  if (!config) return NextResponse.next();

  let response = NextResponse.next({ request });

  const client = createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (written) => {
        for (const { name, value } of written) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of written) response.cookies.set(name, value, options);
      },
    },
  });

  // `getUser` rather than `getSession`: it re-checks the token with the provider, which is what
  // makes the refresh happen at all. Its result is deliberately discarded here — the refreshed
  // cookies are the point, and the pages read the user themselves.
  await client.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    // Everything except static assets and the files Next serves for its own sake. The callback route
    // is deliberately included: it needs the cookie writer as much as any page does.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
