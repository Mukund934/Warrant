import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Ends the session.
 *
 * POST only, and reached from a form rather than a link. A GET sign-out is a one-pixel image away
 * from being triggered by any page on the internet, and while signing someone out is a mild thing to
 * do to them, it is still an action taken without their asking.
 */
export async function POST(request: Request) {
  const client = await supabaseServer();
  if (client) await client.auth.signOut();

  return NextResponse.redirect(new URL("/", new URL(request.url).origin), {
    // 303, so the browser follows with GET rather than repeating the POST.
    status: 303,
  });
}
