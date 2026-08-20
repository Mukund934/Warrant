import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CALLBACK_PATH,
  DEFAULT_LANDING,
  callbackUrl,
  safeRedirectPath,
  signInConfigured,
  supabaseConfig,
} from "../lib/supabase/config.js";

/**
 * The parts of the sign-in flow that can be wrong on their own.
 *
 * Most of an OAuth flow is only testable against a live provider, and that half is verified by hand.
 * What is here is the half that is pure, and it is not the leftovers: an open redirect and a
 * half-configured provider are both defects that a working end-to-end sign-in would happily hide.
 */

const ENV = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
});

afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

const configure = (url?: string, key?: string) => {
  if (url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  else process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  if (key === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  else process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = key;
};

describe("a deployment without an identity provider", () => {
  it("reports itself unconfigured rather than half-configured", () => {
    configure(undefined, undefined);
    expect(supabaseConfig()).toBeNull();
    expect(signInConfigured()).toBe(false);
  });

  // Half-configured is the dangerous state: a client built with one value and a blank other fails
  // at the redirect, long after the person decided to trust the page.
  it("treats a URL with no key, or a key with no URL, as unconfigured", () => {
    configure("https://project.supabase.co", undefined);
    expect(supabaseConfig()).toBeNull();

    configure(undefined, "sb_publishable_example");
    expect(supabaseConfig()).toBeNull();
  });

  it("is configured only when both are present", () => {
    configure("https://project.supabase.co", "sb_publishable_example");
    expect(supabaseConfig()).toEqual({
      url: "https://project.supabase.co",
      publishableKey: "sb_publishable_example",
    });
    expect(signInConfigured()).toBe(true);
  });
});

describe("the callback path is derived, never guessed", () => {
  it("is the single value Supabase must be told about", () => {
    expect(CALLBACK_PATH).toBe("/auth/callback");
  });

  it("builds an absolute redirect URL from the running origin", () => {
    expect(callbackUrl("https://warrant-web.vercel.app")).toBe(
      "https://warrant-web.vercel.app/auth/callback",
    );
    expect(callbackUrl("http://localhost:3000")).toBe("http://localhost:3000/auth/callback");
  });
});

/**
 * `next=` survives a round trip through Google and comes back as something this application will
 * redirect a freshly signed-in person to. That makes it attacker-supplied input on a security path.
 */
describe("the post-sign-in redirect cannot leave this origin", () => {
  it("keeps an ordinary path", () => {
    expect(safeRedirectPath("/console")).toBe("/console");
    expect(safeRedirectPath("/demo/authorised-payment/evidence")).toBe(
      "/demo/authorised-payment/evidence",
    );
    expect(safeRedirectPath("/console?tab=agents")).toBe("/console?tab=agents");
  });

  it("falls back when nothing was asked for", () => {
    expect(safeRedirectPath(null)).toBe(DEFAULT_LANDING);
    expect(safeRedirectPath(undefined)).toBe(DEFAULT_LANDING);
    expect(safeRedirectPath("")).toBe(DEFAULT_LANDING);
  });

  it.each([
    ["https://evil.example/steal", "an absolute URL"],
    ["http://evil.example", "an absolute URL over http"],
    ["//evil.example/steal", "protocol-relative, which resolves off-origin"],
    ["/\\evil.example", "a backslash some browsers normalise to a slash"],
    ["javascript:alert(1)", "a script URL"],
    ["evil.example", "a bare host, which would resolve relative to the current path"],
  ])("refuses %s (%s)", (candidate) => {
    expect(safeRedirectPath(candidate)).toBe(DEFAULT_LANDING);
  });

  it("refuses rather than repairs", () => {
    // Returning a cleaned-up version of a hostile value is how a filter becomes a bypass: the next
    // person assumes the output was sanitised rather than replaced.
    expect(safeRedirectPath("//evil.example/console")).toBe(DEFAULT_LANDING);
    expect(safeRedirectPath("//evil.example/console")).not.toContain("evil.example");
  });
});
