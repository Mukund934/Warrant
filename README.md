# Warrant

[![ci](https://github.com/Mukund934/Warrant/actions/workflows/ci.yml/badge.svg)](https://github.com/Mukund934/Warrant/actions/workflows/ci.yml)

**Proof of who authorised an AI action, under what limits, and who is accountable.**

AI agents have started to take consequential actions — paying invoices, calling banking APIs, moving
money on behalf of organisations. When one of them gets it wrong, the question that matters is who
authorised it. The usual answer is a log file the company itself can edit.

Warrant issues signed, scope-bound mandates that always trace back to a named legal person, checks
them at the moment an agent acts, and produces evidence that a second organisation can verify
without trusting the first.

---

## What this repository is

A **working technical demonstrator**, not a product. The cryptography, the delegation semantics, the
gate and the verifier are real and tested. The organisation, the people, the agents and every payment
are invented, and the signing keys are published here so that every result can be reproduced.

The idea behind it is at validation stage: no customers, no revenue, no production deployment, no
external audit, and no customer interviews completed. That is stated in the interface as well as
here, on a page dedicated to separating what works from what is staged.

---

## Quick start

```bash
npm install
npm test              # 107 tests
npm run dev           # http://localhost:3000
```

No database, no credentials, no environment variables. A fresh clone runs as it stands.

The Express service is a second process, needed only for issuing your own mandates and running your
own actions through the gate. The eight demonstration scenarios and all verification work without it.

```bash
npm run dev:api       # http://localhost:4000
```

To verify an evidence pack from the command line, with no network access:

```bash
npm run build:core && npm run build:verifier
npm run export:packs

node packages/verifier/dist/cli.js \
  evidence/authorised-payment.json \
  --trust-roots evidence/trust-roots.json
```

That exits `0`. Now break it and try again:

```bash
node scripts/tamper.mjs evidence/authorised-payment.json request.amount.minor 420000000

node packages/verifier/dist/cli.js \
  evidence/authorised-payment.tampered.json \
  --trust-roots evidence/trust-roots.json
```

That exits `1` and names four independent checks that caught the edit: the pack fingerprint, the pack
signature, the binding between the recorded decision and the request, and the verdict the verifier
recomputed for itself.

---

## The three objects

**Mandate** — a signed record of what a named legal person granted: which actions, which
counterparties, which limits, until when. Mandates chain, and each hop may only narrow. Every chain
terminates in a person, identified as a person rather than as an email address.

**Gate** — every consequential action is checked against the whole chain before it executes. The
answer is `ALLOW`, `BLOCK` or `ESCALATE`, and the gate signs its own answer.

**Evidence pack** — the chain, the signed request, the signed decision, a hash-chained ledger segment
and a signed revocation snapshot, sealed together. A verifier recomputes the gate's entire evaluation
from the evidence and compares it against the recorded verdict, rather than reading the verdict off
the file.

---

## What it demonstrates

Eight deterministic scenarios, each running the same engine against different authority:

| Scenario | Result | Fails at |
| --- | --- | --- |
| An authorised payment | `ALLOW` | — |
| A payment above the delegated limit | `BLOCK` | `limit.per_action` |
| An agent handing on more than it holds | `BLOCK` | `chain.narrowing` |
| Authority that has lapsed | `BLOCK` | `temporal.validity` |
| A different agent presenting a valid mandate | `BLOCK` | `actor.binding` |
| Authority withdrawn yesterday | `BLOCK` | `revocation.status` |
| A supplier nobody approved | `BLOCK` | `counterparty.allowed` |
| Inside the limit, above the threshold | `ESCALATE` | — |

---

## Layout

```
packages/core       mandate format, scope algebra, gate, ledger, evidence pack, verifier
packages/verifier   standalone command-line verifier
apps/api            Express service: issuance, delegation, gate, evidence, revocation
apps/web            demonstrator, evidence pack view, in-browser verification
scripts             key generation, pack export, a tamper helper for testing
```

Issuing, delegating, gate evaluation and evidence generation are server-side, in `apps/api`.
Verification deliberately is not confined there — a relying party has to be able to check evidence on
their own machine, so the same verification code runs in the service, in the CLI and in the browser.

State sits behind four interfaces — `MandateRepository`, `EvidenceRepository`, `LedgerRepository`
and `NonceStore` — each with an in-memory and a PostgreSQL implementation. The service picks
between them at startup depending on whether `DATABASE_URL` is set, and nothing in the authority
model depends on which is behind them: `packages/core` and the verifier have no database code in
them at all. A fresh clone runs with no credentials and no provisioning.

The Postgres store is not just the same code against a table. Replay protection is a single insert
against a unique constraint, so two instances cannot both accept one nonce; the ledger reads its
head under a lock and appends in the same transaction, so simultaneous writes produce one chain
rather than a fork; and `ledger_entries` and `evidence_packs` refuse `UPDATE` and `DELETE` at the
database, not by convention.

## Cryptography

Nothing here is invented. ES256 (ECDSA P-256 with SHA-256) via `jose` over Web Crypto; detached
compact JWS per RFC 7515 Appendix F, with the algorithm, key identifier and issue time in the
protected header so all three are covered by the signature; RFC 8785 canonical JSON; SHA-256 digests.
Money is integer minor units with an explicit currency, so no floating point ever reaches a limit
comparison.

## Security assumptions

The signing keys in `packages/core/src/fixtures/keys.ts` are **published, private halves included**.
Anyone can issue a mandate this deployment will accept. That is deliberate — it makes every result
reproducible — and it is why a real deployment keeps signing keys in an HSM.

Beyond that: nothing is persisted, there is no authentication or tenancy, replay protection is not
shared between server instances, the ledger is not anchored to an external transparency log, and
there is no key rotation or key discovery. The technical notes page in the app lists each of these
against what production would require, and measures the implementation against the ten requirements
in the IETF's cross-organisational delegation problem statement — four met, four partly met, two not
attempted.

## Licence

Not yet licensed. Ask before reusing.
