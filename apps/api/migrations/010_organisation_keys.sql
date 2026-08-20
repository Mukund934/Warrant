-- Phase 9. Each organisation signs its own authority with its own keys, so that one organisation's
-- evidence does not verify under another's trust roots. Until now every tenant shared the
-- demonstration principal, gate and ledger keys, which made tenancy a data boundary and not a
-- cryptographic one.
--
-- Additive: nothing already recorded changes, no signed format moves, and an organisation created
-- before this migration simply has no row here and keeps using the demonstration keys.

create table if not exists organisation_keys (
  key_id text primary key,
  organisation_id text not null references organisations (id),
  role text not null check (role in ('principal', 'gate', 'ledger')),
  public_key_jwk jsonb not null,
  private_key_jwk jsonb not null,
  created_at timestamptz not null default now(),
  -- One key per role per organisation. Rotation is a later concern and would relax this
  -- deliberately, the way agent_keys does with signing_until, rather than by accident.
  constraint organisation_keys_one_per_role unique (organisation_id, role)
);

create index if not exists organisation_keys_organisation_idx
  on organisation_keys (organisation_id);

grant select, insert on organisation_keys to warrant_api;
revoke update, delete, truncate on organisation_keys from warrant_api;
