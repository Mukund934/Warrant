import Link from "next/link";
import { Eyebrow, Section } from "@/components/primitives";

export const metadata = { title: "Not found" };

const ELSEWHERE = [
  { href: "/how-it-works", label: "How it works", detail: "The mandate, the gate and the evidence" },
  { href: "/demo", label: "Demonstrator", detail: "Eight scenarios, three verdicts" },
  { href: "/verify", label: "Verify evidence", detail: "Check a pack in your own browser" },
  { href: "/docs", label: "Documentation", detail: "Verify evidence you did not produce" },
  { href: "/technical", label: "Technical notes", detail: "Formats, checks and standards" },
  { href: "/security", label: "Security", detail: "Trust model and known limitations" },
];

export default function NotFound() {
  return (
    <Section width="prose" className="py-16 sm:py-24">
      <Eyebrow>404</Eyebrow>
      <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[34px]">
        There is nothing at this address
      </h1>
      <p className="mt-4 text-[15px] leading-relaxed text-text-muted">
        The page may have been renamed, or the link may be wrong. Everything on the site is reachable
        from here.
      </p>

      <ul className="mt-10 divide-y divide-line border-y border-line">
        {ELSEWHERE.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3.5 transition-colors hover:text-text"
            >
              <span className="text-[14.5px] font-medium text-text">{item.label}</span>
              <span className="text-[13px] text-text-faint">{item.detail}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}
