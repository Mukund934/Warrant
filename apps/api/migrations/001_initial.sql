create table if not exists mandates (
  id text primary key,
  parent_id text references mandates (id),
  depth integer not null check (depth >= 0),
  organisation_id text not null,
  liable_principal_id text not null,
  subject_id text not null,
  issuer_key_id text not null,
  not_before timestamptz not null,
  expires_at timestamptz not null,
  issued_at timestamptz not null,
  document jsonb not null,
  revoked_at timestamptz,
  revocation_reason text,
  created_at timestamptz not null default now(),
  constraint mandates_validity_window check (expires_at > not_before),
  constraint mandates_root_has_no_parent check ((depth = 0) = (parent_id is null)),
  constraint mandates_revocation_is_complete
    check ((revoked_at is null) = (revocation_reason is null))
);

create index if not exists mandates_parent_idx on mandates (parent_id);
create index if not exists mandates_subject_idx on mandates (subject_id);
create index if not exists mandates_revoked_idx on mandates (revoked_at) where revoked_at is not null;

create table if not exists evidence_packs (
  pack_id text primary key,
  root_mandate_id text not null,
  verdict text not null check (verdict in ('ALLOW', 'BLOCK', 'ESCALATE')),
  evaluated_at timestamptz not null,
  generated_at timestamptz not null,
  amount_currency text,
  amount_minor bigint check (amount_minor is null or amount_minor >= 0),
  document jsonb not null,
  created_at timestamptz not null default now(),
  constraint evidence_amount_is_complete
    check ((amount_currency is null) = (amount_minor is null))
);

create index if not exists evidence_recent_idx on evidence_packs (evaluated_at desc);
create index if not exists evidence_root_window_idx
  on evidence_packs (root_mandate_id, amount_currency, evaluated_at desc)
  where verdict = 'ALLOW';

create table if not exists ledger_entries (
  seq bigint primary key,
  type text not null,
  ref text not null,
  recorded_at timestamptz not null,
  payload_digest text not null,
  prev_digest text not null,
  digest text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists ledger_ref_idx on ledger_entries (ref);

create table if not exists nonces (
  nonce text primary key,
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists nonces_expiry_idx on nonces (expires_at);

create or replace function warrant_refuse_mutation() returns trigger as $$
begin
  raise exception 'warrant: % is append-only; % is not permitted', tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$ language plpgsql;

drop trigger if exists ledger_entries_are_append_only on ledger_entries;
create trigger ledger_entries_are_append_only
  before update or delete on ledger_entries
  for each row execute function warrant_refuse_mutation();

drop trigger if exists evidence_packs_are_append_only on evidence_packs;
create trigger evidence_packs_are_append_only
  before update or delete on evidence_packs
  for each row execute function warrant_refuse_mutation();
