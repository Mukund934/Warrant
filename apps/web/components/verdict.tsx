import type { Check, Verdict } from "@warrant/core";

const VERDICT_STYLES: Record<Verdict, { ring: string; text: string; label: string; blurb: string }> = {
  ALLOW: {
    ring: "border-pass/45 bg-pass/[0.08]",
    text: "text-pass",
    label: "ALLOW",
    blurb: "the action was inside the authority that was granted",
  },
  BLOCK: {
    ring: "border-fail/45 bg-fail/[0.08]",
    text: "text-fail",
    label: "BLOCK",
    blurb: "the action was refused before it could execute",
  },
  ESCALATE: {
    ring: "border-warn/45 bg-warn/[0.08]",
    text: "text-warn",
    label: "ESCALATE",
    blurb: "the action was held for a named human to approve",
  },
};

export function VerdictBadge({ verdict, size = "md" }: { verdict: Verdict; size?: "sm" | "md" }) {
  const style = VERDICT_STYLES[verdict];
  const scale = size === "sm" ? "px-2.5 py-1 text-[11px]" : "px-3.5 py-1.5 text-[13px]";
  return (
    <span
      className={`inline-flex items-center rounded-md border font-semibold tracking-[0.1em] ${scale} ${style.ring} ${style.text}`}
    >
      {style.label}
    </span>
  );
}

export function VerdictPanel({ verdict, reason }: { verdict: Verdict; reason: string }) {
  const style = VERDICT_STYLES[verdict];
  return (
    <div className={`rounded-lg border px-5 py-4 ${style.ring}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className={`text-[22px] font-semibold tracking-[0.06em] ${style.text}`}>
          {style.label}
        </span>
        <span className="text-[13px] text-text-faint">{style.blurb}</span>
      </div>
      <p className="mt-2 text-[14.5px] leading-relaxed text-text">{reason}</p>
    </div>
  );
}

const STATUS: Record<Check["status"], { mark: string; text: string; border: string; title: string }> = {
  pass: { mark: "✓", text: "text-pass", border: "border-pass/35", title: "passed" },
  fail: { mark: "✕", text: "text-fail", border: "border-fail/45", title: "failed" },
  warn: { mark: "!", text: "text-warn", border: "border-warn/45", title: "needs attention" },
  skip: { mark: "–", text: "text-text-faint", border: "border-line", title: "not applicable here" },
};

export function CheckRow({ check }: { check: Check }) {
  const status = STATUS[check.status];
  const highlighted = check.status === "fail" || check.status === "warn";
  return (
    <li
      className={`flex gap-3 border-b border-line px-4 py-3 last:border-b-0 ${
        highlighted ? "bg-ink-raised" : ""
      }`}
    >
      <span
        aria-hidden
        className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border text-[11px] font-bold ${status.border} ${status.text}`}
      >
        {status.mark}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium text-text">
          {check.title}
          <span className="sr-only"> — {status.title}</span>
        </p>
        <p className="mt-0.5 text-[13px] leading-relaxed text-text-muted">{check.detail}</p>
        {(check.expected !== undefined || check.observed !== undefined) && (
          <dl className="mt-2 grid gap-x-4 gap-y-1 text-[12.5px] sm:grid-cols-2">
            <div className="flex gap-2">
              <dt className="text-text-faint">Permitted</dt>
              <dd className="font-mono text-text-muted break-all">{check.expected ?? "—"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-text-faint">Requested</dt>
              <dd className={`font-mono break-all ${highlighted ? status.text : "text-text-muted"}`}>
                {check.observed ?? "—"}
              </dd>
            </div>
          </dl>
        )}
      </div>
    </li>
  );
}

export function CheckList({ checks, caption }: { checks: Check[]; caption?: string }) {
  const failures = checks.filter((check) => check.status === "fail").length;
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface">
      {caption && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <h3 className="text-[13px] font-medium text-text">{caption}</h3>
          <p className="text-[12px] text-text-faint">
            {checks.length} checks
            {failures > 0 ? ` · ${failures} failed` : ""}
          </p>
        </div>
      )}
      <ul>
        {checks.map((check, index) => (
          <CheckRow key={`${check.id}-${index}`} check={check} />
        ))}
      </ul>
    </div>
  );
}
