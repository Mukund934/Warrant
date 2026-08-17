import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Warrant — proof of who authorised an AI action",
    template: "%s — Warrant",
  },
  description:
    "A working demonstrator of verifiable authority for AI agents: signed mandates that only narrow, a gate that signs its own verdict, and evidence anyone can verify offline.",
};

const NAV = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/demo", label: "Demonstrator" },
  { href: "/verify", label: "Verify evidence" },
  { href: "/docs", label: "Docs" },
  { href: "/technical", label: "Technical notes" },
  { href: "/security", label: "Security" },
];

const FOOTER_LINKS = [
  { href: "/about", label: "About" },
  { href: "/security", label: "Security" },
  { href: "/status", label: "What is real and what is not" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-surface focus:px-4 focus:py-2 focus:text-sm"
        >
          Skip to content
        </a>

        <header className="sticky top-0 z-40 border-b border-line bg-ink/85 backdrop-blur-md">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-5 py-3.5">
            <Link href="/" className="flex items-center gap-2.5 shrink-0">
              <span className="grid h-7 w-7 place-items-center rounded-[5px] border border-seal-dim bg-seal/10 text-[11px] font-semibold tracking-[0.14em] text-seal">
                W
              </span>
              <span className="text-[15px] font-semibold tracking-tight">Warrant</span>
            </Link>

            <nav aria-label="Primary" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13.5px]">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-text-muted transition-colors hover:text-text"
                >
                  {item.label}
                </Link>
              ))}
            </nav>

            <a
              href="https://github.com/Mukund934/Warrant"
              className="ml-auto hidden shrink-0 rounded-full border border-line px-2.5 py-1 text-[11px] uppercase tracking-[0.13em] text-text-faint transition-colors hover:border-line-strong hover:text-text-muted sm:inline"
              rel="noreferrer noopener"
            >
              Source
            </a>
          </div>
        </header>

        <main id="main">{children}</main>

        <footer className="mt-24 border-t border-line">
          <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10 text-[13px] text-text-faint sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-md space-y-2">
              <p className="text-text-muted">
                Warrant — an independent project by Mukund Thakur.
              </p>
              <p>
                Early stage, built in the open. The cryptography and the verification are real; the
                organisations and payments in the demonstration are not.
              </p>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {FOOTER_LINKS.map((item) => (
                <Link key={item.href} href={item.href} className="transition-colors hover:text-text">
                  {item.label}
                </Link>
              ))}
              <a
                href="https://github.com/Mukund934/Warrant"
                className="transition-colors hover:text-text"
                rel="noreferrer noopener"
              >
                Source
              </a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
