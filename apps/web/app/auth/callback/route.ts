import { NextResponse } from "next/server";
import { safeRedirectPath } from "@/lib/supabase/config";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Where Google, by way of Supabase, sends the browser back.
 *
 * **This path is the answer to "what Redirect URL should Supabase be given".** It is
 * `CALLBACK_PATH` in `lib/supabase/config.ts`, and it is derived from this file rather than the
 * other way round — a redirect URL guessed before the route exists is how an OAuth flow ends up
 * configured for a path nothing serves.
 *
 * The PKCE exchange happens here, server-side. The code verifier lives in an httpOnly cookie the
 * browser client set before redirecting, so the exchange cannot be completed by anyone who merely
 * observed the `code` in a URL.
 */

const failure = (origin: string, reason: string) =>
  NextResponse.redirect(new URL(`/sign-in?error=${encodeURIComponent(reason)}`, origin));

export async function GET(request: Request) {
  const url = new URL(request.url);
  const { origin, searchParams } = url;

  // The provider reports its own failures here too — a declined consent screen arrives as `error`,
  // not as a missing code, and telling the two apart is the difference between "you cancelled" and
  // "something is broken".
  const provider = searchParams.get("error_description") ?? searchParams.get("error");
  if (provider) return failure(origin, provider);

  const code = searchParams.get("code");
  if (!code) return failure(origin, "no authorisation code was returned");

  const client = await supabaseServer();
  if (!client) return failure(origin, "this deployment has no identity provider configured");

  const { error } = await client.auth.exchangeCodeForSession(code);
  if (error) return failure(origin, error.message);

  return NextResponse.redirect(new URL(safeRedirectPath(searchParams.get("next")), origin));
}
