# Security policy

## Reporting a vulnerability

Please report privately using
[GitHub security advisories](https://github.com/Mukund934/Warrant/security/advisories/new) rather
than opening a public issue.

Include what you did, what you expected, and what happened. A minimal reproduction — a pack, a
chain, or a request that behaves wrongly — is worth more than a description.

This is an independent project maintained by one person. There is no guaranteed response time and
no bug bounty. Reports are read and answered as soon as they are seen.

## What is most useful

The claim this project makes is narrow and testable: **a party who does not trust the issuer can
reproduce an authority decision offline and reach the same verdict.** Anything that breaks that is
the most valuable thing you can send.

Concretely:

- A delegation that widens authority in any dimension and is accepted.
- A chain that splices, reorders or reparents and still verifies.
- A signature accepted over a document it was not made for, including through canonicalisation.
- An evidence pack altered in any way that still verifies against published keys.
- A verdict the offline verifier reproduces differently from the recorded decision, where the
  recorded decision is the wrong one.
- A request replayed or presented outside its acceptance window and allowed.
- Any path by which a private key, or material sufficient to derive one, leaves the signing boundary.

## What is already known, and is not a vulnerability

These are deliberate properties of a public demonstration. They are documented on the
[security page](https://warrant-web.vercel.app/security) and do not need reporting:

- **Demonstration private keys are published** in this repository and served from the site, so that
  anyone can reproduce a scenario and forge a pack to watch it be rejected. No key here protects
  anything.
- **The demonstration API declares itself open, and therefore has no authentication.** Anyone can
  issue mandates under the demonstration keys. A deployment chooses `open` or `required` and
  reports which on `/health`; in `required` mode the authority endpoints need an ES256 access
  token from the configured identity provider, and every record is scoped to an organisation.
  **Authentication never moves a verdict** — the decision is a function of the mandate chain and
  the signed evaluation inputs alone, so an offline verifier that never saw the caller reaches
  the same result.
- **Tenant separation is a data boundary, not yet a cryptographic one.** Organisations cannot
  read each other's mandates, evidence or revocations, but the same demonstration keys sign for
  all of them. Separately administered organisations with independent trust roots is a later
  phase, and is not claimed here.
- **Replay protection is process-scoped.** Nonce novelty is tracked in memory by a single process,
  and the service reports its own replay scope on `/health`.
- **The ledger is tamper-evident, not tamper-proof.** Hash chaining with a signed head detects
  third-party alteration; it does not prevent the issuing organisation rewriting its own history.
  External anchoring is not built yet.
- **There is no key discovery.** Trust roots are supplied to the verifier; keys embedded in a pack
  prove internal consistency only, and the verifier says so.
- **Every organisation, person, agent and payment in the demonstration is invented.**

## Supported versions

The project is pre-1.0 and under active development. Only `main` is supported; there are no
maintained release branches.
