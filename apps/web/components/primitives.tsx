import type { ReactNode } from "react";

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`font-mono text-[12.5px] leading-relaxed break-all text-text-muted ${className}`}>
      {children}
    </span>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <span className="text-[11px] font-medium uppercase tracking-[0.13em] text-text-faint">
      {children}
    </span>
  );
}

export function Card({
  children,
  className = "",
  as: Element = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article" | "li";
}) {
  return (
    <Element className={`rounded-lg border border-line bg-surface ${className}`}>{children}</Element>
  );
}

export function Section({
  children,
  className = "",
  width = "wide",
}: {
  children: ReactNode;
  className?: string;
  width?: "wide" | "prose";
}) {
  const max = width === "prose" ? "max-w-3xl" : "max-w-6xl";
  return <section className={`mx-auto ${max} px-5 ${className}`}>{children}</section>;
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="mb-3 text-[11px] font-medium uppercase tracking-[0.16em] text-seal">{children}</p>
  );
}

export function Note({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "caution" }) {
  const styles =
    tone === "caution"
      ? "border-seal-dim bg-seal/[0.06] text-text-muted"
      : "border-line bg-ink-raised text-text-muted";
  return (
    <div className={`rounded-md border px-4 py-3 text-[13.5px] leading-relaxed ${styles}`}>
      {children}
    </div>
  );
}

export function DefinitionRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-b border-line py-2.5 last:border-b-0 sm:grid-cols-[minmax(0,10rem)_1fr] sm:gap-4">
      <dt className="text-[13px] text-text-faint">{term}</dt>
      <dd className="text-[13.5px] text-text">{children}</dd>
    </div>
  );
}
