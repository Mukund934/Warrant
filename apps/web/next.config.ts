import type { NextConfig } from "next";

const development = process.env.NODE_ENV === "development";

/**
 * The identity provider's origin, and only its origin.
 *
 * `connect-src 'self'` was right for every page that existed before sign-in, and it would have
 * broken the one that did not: the browser client refreshes a session by calling Supabase
 * directly. Derived from the configured URL rather than written out, so a different project
 * cannot be reached, and a missing variable simply leaves the policy exactly as it was.
 */
const supabaseOrigin = (() => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
})();

const connectSrc = ["'self'", ...(supabaseOrigin ? [supabaseOrigin] : [])].join(" ");

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    return [{ source: "/.well-known/jwks.json", destination: "/api/jwks" }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "font-src 'self'",
              `connect-src ${connectSrc}`,
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default config;
