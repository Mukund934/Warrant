"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/browser";

type State = { status: "unknown" } | { status: "out" } | { status: "in"; email?: string };

/**
 * The header's sign-in state, decided in the browser on purpose.
 *
 * Reading the session in the root layout would mean reading cookies there, and that makes every page
 * in the site dynamic — including the documentation and the demonstrator, which are static today and
 * should stay that way. So this is presentation only.
 *
 * **It is not a control.** What a signed-out person may reach is decided server-side by the pages
 * themselves and by the Warrant API, both of which re-check the token. Nothing here can grant access
 * by rendering a link, and nothing is lost if it renders the wrong one for a moment.
 */
export function SessionControl() {
  const [state, setState] = useState<State>({ status: "unknown" });

  useEffect(() => {
    const client = supabaseBrowser();
    if (!client) {
      setState({ status: "out" });
      return;
    }

    let live = true;

    client.auth.getUser().then(({ data }) => {
      if (!live) return;
      setState(
        data.user ? { status: "in", ...(data.user.email ? { email: data.user.email } : {}) } : { status: "out" },
      );
    });

    const { data: subscription } = client.auth.onAuthStateChange((_event, session) => {
      if (!live) return;
      setState(
        session?.user
          ? { status: "in", ...(session.user.email ? { email: session.user.email } : {}) }
          : { status: "out" },
      );
    });

    return () => {
      live = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  // Nothing at all until it is known, rather than a link that flips: a header that changes shape
  // after hydration is worse than one that arrives a moment late.
  if (state.status === "unknown") return <span className="h-[26px]" aria-hidden />;

  if (state.status === "out") {
    return (
      <Link
        href="/sign-in"
        className="rounded-full border border-line px-2.5 py-1 text-[11px] uppercase tracking-[0.13em] text-text-faint transition-colors hover:border-line-strong hover:text-text-muted"
      >
        Sign in
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <Link
        href="/console"
        className="rounded-full border border-seal-dim px-2.5 py-1 text-[11px] uppercase tracking-[0.13em] text-seal transition-colors hover:border-seal"
        title={state.email}
      >
        Console
      </Link>
      <form action="/auth/sign-out" method="post">
        <button
          type="submit"
          className="text-[11px] uppercase tracking-[0.13em] text-text-faint transition-colors hover:text-text-muted"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}
