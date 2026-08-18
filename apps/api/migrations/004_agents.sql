create table if not exists agents (
  id text primary key,
  organisation_id text not null references organisations (id),
  name text not null,
  runtime text not null,
  status text not null check (status in ('registered', 'active', 'suspended', 'revoked', 'archived')),
  registered_at timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  status_reason text,
  constraint agents_name_is_unique_per_organisation unique (organisation_id, name)
);

create index if not exists agents_organisation_idx on agents (organisation_id, status);

create table if not exists agent_keys (
  key_id text primary key,
  agent_id text not null references agents (id),
  public_key_jwk jsonb not null,
  signing_from timestamptz not null,
  signing_until timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists agent_keys_agent_idx on agent_keys (agent_id);

create unique index if not exists agent_keys_one_current_per_agent
  on agent_keys (agent_id) where signing_until is null;

grant select, insert, update on agents to warrant_api;
grant select, insert, update on agent_keys to warrant_api;
revoke delete, truncate on agents from warrant_api;
revoke delete, truncate on agent_keys from warrant_api;
