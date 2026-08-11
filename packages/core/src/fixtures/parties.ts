import type { Agent, LegalPerson, Mandate, Money, Scope } from "../types.js";
import { apAgentKey, payAgentKey, principalKey, rogueAgentKey, settleAgentKey } from "./keys.js";

export const organisation: Mandate["organisation"] = {
  id: "org:meridian-technologies",
  name: "Meridian Technologies Pvt Ltd",
  jurisdiction: "IN-MH",
};

export const priyaSharma: LegalPerson = {
  kind: "legal_person",
  id: "person:priya-sharma",
  name: "Priya Sharma",
  role: "Head of Finance",
  legalEntity: "Meridian Technologies Pvt Ltd",
  identifier: "DIN 09214477",
  keyId: principalKey.keyId,
};

export const apAgent: Agent = {
  kind: "agent",
  id: "agent:ap-agent-01",
  name: "AP-Agent-01",
  runtime: "Accounts payable agent, MCP runtime",
  keyId: apAgentKey.keyId,
};

export const paymentAgent: Agent = {
  kind: "agent",
  id: "agent:pay-agent-07",
  name: "PAY-Agent-07",
  runtime: "Payment execution agent, MCP runtime",
  keyId: payAgentKey.keyId,
};

export const settlementAgent: Agent = {
  kind: "agent",
  id: "agent:settle-agent-12",
  name: "SETTLE-Agent-12",
  runtime: "Settlement agent, MCP runtime",
  keyId: settleAgentKey.keyId,
};

export const rogueAgent: Agent = {
  kind: "agent",
  id: "agent:rogue-agent-99",
  name: "RECON-Agent-99",
  runtime: "Unregistered agent, MCP runtime",
  keyId: rogueAgentKey.keyId,
};

export const inr = (major: number): Money => ({ currency: "INR", minor: Math.round(major * 100) });

export const ERP = "erp:meridian/accounts-payable";
export const BANK = "bank:hdfc/corporate-api";

export const KALYANI = "Kalyani Steel Works";
export const SUNDARAM = "Sundaram Fasteners";
export const NAGPUR = "Nagpur Logistics";
export const UNLISTED = "Vantage Global Trading FZE";

export const rootScope: Scope = {
  actions: ["invoice.read", "payment.approve", "payment.execute"],
  audience: [ERP, BANK],
  counterparties: { allow: [KALYANI, SUNDARAM, NAGPUR] },
  limits: {
    perAction: inr(1_000_000),
    perPeriod: { amount: inr(4_000_000), days: 30 },
  },
  purpose: "Settlement of approved supplier invoices",
};

export const TIMELINE = {
  rootIssuedAt: "2026-08-01T09:00:00Z",
  rootNotBefore: "2026-08-01T00:00:00Z",
  rootExpiresAt: "2026-09-30T23:59:59Z",
  delegatedIssuedAt: "2026-08-01T09:05:00Z",
  lapsedIssuedAt: "2026-05-02T09:00:00Z",
  lapsedNotBefore: "2026-05-02T00:00:00Z",
  lapsedExpiresAt: "2026-07-31T23:59:59Z",
  revokedAt: "2026-08-19T11:20:00Z",
  revocationAsOf: "2026-08-20T14:00:00Z",
  evaluatedAt: "2026-08-20T14:32:07Z",
  recordedAt: "2026-08-20T14:32:07Z",
  packGeneratedAt: "2026-08-20T14:33:00Z",
} as const;

export const ESCALATION_THRESHOLD = inr(450_000);
export const PRIOR_PERIOD_SPEND = inr(630_000);
