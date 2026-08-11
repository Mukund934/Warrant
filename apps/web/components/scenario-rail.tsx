import Link from "next/link";
import type { ScenarioRun } from "@warrant/core/fixtures";
import { VerdictBadge } from "./verdict";

export function ScenarioRail({
  scenarios,
  activeId,
}: {
  scenarios: ScenarioRun[];
  activeId: string;
}) {
  return (
    <nav aria-label="Demonstration scenarios">
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {scenarios.map((scenario) => {
          const active = scenario.id === activeId;
          return (
            <li key={scenario.id}>
              <Link
                href={`/demo/${scenario.id}`}
                aria-current={active ? "page" : undefined}
                className={`flex h-full flex-col gap-2 rounded-lg border px-4 py-3 transition-colors ${
                  active
                    ? "border-seal/60 bg-seal/[0.07]"
                    : "border-line bg-surface hover:border-line-strong hover:bg-surface-raised"
                }`}
              >
                <VerdictBadge verdict={scenario.expected} size="sm" />
                <span className="text-[13.5px] font-medium leading-snug text-text">
                  {scenario.title}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
