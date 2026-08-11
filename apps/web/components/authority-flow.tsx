const STAGES = [
  {
    step: "01",
    title: "A legal person",
    detail: "Priya Sharma, Head of Finance, named with a company identifier rather than an email",
  },
  {
    step: "02",
    title: "grants a mandate",
    detail: "signed, scope-bound, time-bound, and it may only narrow when it is passed on",
  },
  {
    step: "03",
    title: "an agent acts on it",
    detail: "the agent holds the mandate and presents it with every consequential action",
  },
  {
    step: "04",
    title: "the gate decides",
    detail: "allow, block or escalate — checked before the action runs, and signed by the gate",
  },
  {
    step: "05",
    title: "evidence is produced",
    detail: "the chain, the decision and the ledger segment, sealed together as one artifact",
  },
  {
    step: "06",
    title: "anyone can check it",
    detail: "an auditor, an insurer or a counterparty verifies it offline, trusting nobody",
  },
];

export function AuthorityFlow() {
  return (
    <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {STAGES.map((stage, index) => (
        <li
          key={stage.step}
          className={`relative rounded-lg border px-4 py-4 ${
            index === STAGES.length - 1
              ? "border-seal/45 bg-seal/[0.06]"
              : "border-line bg-surface"
          }`}
        >
          <div className="flex items-baseline gap-2.5">
            <span
              className={`font-mono text-[11px] ${
                index === STAGES.length - 1 ? "text-seal" : "text-text-faint"
              }`}
            >
              {stage.step}
            </span>
            <h3 className="text-[14.5px] font-semibold text-text">{stage.title}</h3>
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-text-muted">{stage.detail}</p>
        </li>
      ))}
    </ol>
  );
}
