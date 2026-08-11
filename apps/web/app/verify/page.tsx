import Link from "next/link";
import { demoScenarios, trustRoots } from "@warrant/core/fixtures";
import { Eyebrow, Note, Section } from "@/components/primitives";
import { VerifyConsole } from "@/components/verify-console";

export const metadata = { title: "Verify evidence" };

export default async function VerifyPage({
  searchParams,
}: {
  searchParams: Promise<{ scenario?: string }>;
}) {
  const { scenario: requested } = await searchParams;
  const scenarios = await demoScenarios();
  const scenario = scenarios.find((item) => item.id === requested) ?? scenarios[0]!;

  return (
    <Section className="py-10 sm:py-14">
      <header className="mb-8 max-w-3xl">
        <Eyebrow>Independent verification</Eyebrow>
        <h1 className="text-[26px] font-semibold leading-tight tracking-tight sm:text-[32px]">
          Check the evidence yourself, without asking us anything
        </h1>
        <p className="mt-3 text-[14.5px] leading-relaxed text-text-muted">
          The pack and the signing keys are already on this page. Verification runs in your browser:
          it recomputes every digest, checks every signature, and re-runs the whole authority
          evaluation from scratch rather than reading the recorded verdict off the file.
        </p>
      </header>

      <div className="mb-8">
        <Note tone="caution">
          <strong className="font-medium text-text">Try this.</strong> Turn off your network, then
          press Verify. Nothing on this page needs a connection once it has loaded — that is the
          whole point of the claim, so it should be testable rather than asserted.
        </Note>
      </div>

      <VerifyConsole
        scenarios={scenarios.map((item) => ({
          id: item.id,
          title: item.title,
          expected: item.expected,
        }))}
        activeScenarioId={scenario.id}
        pack={scenario.pack}
        publishedTrustRoots={trustRoots}
      />

      <div className="mt-10 max-w-3xl space-y-3 text-[13.5px] leading-relaxed text-text-muted">
        <p>
          A browser is not an air gap. For a check that is provably offline, run the same verifier as
          a command-line program — it disables network access before it starts, and its source is a
          few hundred lines you can read.{" "}
          <Link href="/technical" className="text-seal hover:underline">
            The commands are on the technical notes page.
          </Link>
        </p>
      </div>
    </Section>
  );
}
