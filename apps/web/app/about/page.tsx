import Link from "next/link";
import { DefinitionRow, Eyebrow, Note, Section } from "@/components/primitives";

export const metadata = { title: "About" };

export default function AboutPage() {
  return (
    <Section width="prose" className="py-10 sm:py-14">
      <header className="mb-10">
        <Eyebrow>About</Eyebrow>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[34px]">
          An independent project, built in the open
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-text-muted">
          Warrant is authority and accountability infrastructure for AI agents: signed, scope-bound
          delegation that always traces to a named legal person, a gate that signs its own verdict,
          and evidence a second organisation can verify without trusting the first.
        </p>
      </header>

      <div className="space-y-12">
        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">Why it exists</h2>
          <p className="text-[14.5px] leading-relaxed text-text-muted">
            Agents have started taking consequential actions — paying invoices, calling banking APIs,
            moving money for organisations. When one gets it wrong, the question that decides
            everything afterwards is who authorised it, under what limits, and who is accountable.
            The usual answer is a log file the company itself can edit.
          </p>
          <p className="mt-4 text-[14.5px] leading-relaxed text-text-muted">
            The interesting part of that problem is not the enforcement. It is that the answer has to
            survive leaving the building. A decision only one party can check is not accountability;
            it is a claim. So the design goal here is narrow and testable:{" "}
            <span className="text-text">
              a stranger can independently reproduce the authority decision for a multi-hop delegated
              action, offline, without contacting us.
            </span>{" "}
            The <Link href="/verify" className="text-seal hover:underline">verifier</Link> is the
            product; the gate is the setup.
          </p>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">Where it stands</h2>
          <Note tone="caution">
            Early stage, stated plainly: <strong className="text-text">no customers, no revenue, no
            production deployment, no external audit and no certification.</strong> The engineering
            is built for production. The company is not a company yet. Nothing on this site should be
            read as a claim of adoption.
          </Note>
          <dl className="mt-6">
            <DefinitionRow term="Stage">
              Working system, publicly deployed, under active development
            </DefinitionRow>
            <DefinitionRow term="What is real">
              The cryptography, the scope algebra, the gate, the ledger and the offline verifier
            </DefinitionRow>
            <DefinitionRow term="What is invented">
              Every organisation, person, agent and payment in the demonstration
            </DefinitionRow>
            <DefinitionRow term="Detail">
              <Link href="/status" className="text-seal hover:underline">
                What is real, what is invented, and what does not exist
              </Link>
            </DefinitionRow>
          </dl>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">Who builds it</h2>
          <p className="text-[14.5px] leading-relaxed text-text-muted">
            Warrant is an independent project by <span className="text-text">Mukund Thakur</span>,
            an electronics and communication engineering undergraduate at IIIT Naya Raipur. It is
            built and maintained by one person, in public, with the source and the reasoning both
            open to inspection.
          </p>
          <p className="mt-4 text-[14.5px] leading-relaxed text-text-muted">
            That is deliberate rather than incidental. A verification format nobody else can
            implement is not a format, so the specification decisions, the standards this does and
            does not follow, and the claims that did not survive checking are all written down on the{" "}
            <Link href="/technical" className="text-seal hover:underline">technical notes</Link>{" "}
            page rather than smoothed over.
          </p>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">Getting in touch</h2>
          <p className="text-[14.5px] leading-relaxed text-text-muted">
            The source is on{" "}
            <a
              href="https://github.com/Mukund934/Warrant"
              className="text-seal hover:underline"
              rel="noreferrer noopener"
            >
              GitHub
            </a>
            . Issues and questions are welcome there. For anything security-related, please read the{" "}
            <Link href="/security" className="text-seal hover:underline">security page</Link> first —
            it explains the trust model, the known limitations, and how to report a vulnerability
            privately.
          </p>
        </section>
      </div>
    </Section>
  );
}
