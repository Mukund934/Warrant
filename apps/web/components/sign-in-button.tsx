"use client";

import { useState } from "react";
import { CALLBACK_PATH } from "@/lib/supabase/config";
import { supabaseBrowser } from "@/lib/supabase/browser";

/**
 * Starts the OAuth redirect, and does nothing else.
 *
 * The only client-side step in the whole flow. Everything after the provider sends the browser back
 * happens on the server: the code exchange, the session cookie, and every call to the Warrant API.
 * Client code is never handed an access token to forward.
 */
export function SignInButton({ next }: { next?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start() {
    const client = supabaseBrowser();
    if (!client) {
      setFailed("this deployment has no identity provider configured");
      return;
    }

    setBusy(true);
    setFailed(null);

    // Built from the running origin rather than a configured value, so a preview deployment sends
    // people back to the preview rather than to production.
    const redirect = new URL(CALLBACK_PATH, window.location.origin);
    if (next) redirect.searchParams.set("next", next);

    const { error } = await client.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: redirect.toString(),
        // Only what identifies a person. Nothing here reads mail, files or a calendar, and asking
        // for a scope in case it is useful later is how consent screens stop being read.
        scopes: "openid email profile",
      },
    });

    if (error) {
      setFailed(error.message);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="inline-flex items-center gap-2.5 rounded-md border border-line-strong bg-surface-raised px-4 py-2.5 text-[14px] font-medium transition-colors hover:border-seal-dim disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span
          aria-hidden
          className="grid h-4 w-4 place-items-center rounded-full border border-line-strong text-[10px] font-semibold"
        >
          G
        </span>
        {busy ? "Redirecting to Google…" : "Continue with Google"}
      </button>

      {failed ? (
        <p role="alert" className="text-[13px] text-fail">
          {failed}
        </p>
      ) : null}
    </div>
  );
}
