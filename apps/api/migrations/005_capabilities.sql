create table if not exists capabilities (
  organisation_id text not null references organisations (id),
  id text not null,
  title text not null,
  description text not null,
  risk text not null check (risk in ('low', 'medium', 'high', 'critical')),
  amount_rule text not null check (amount_rule in ('required', 'optional', 'forbidden')),
  currencies text[],
  approval_above_currency text,
  approval_above_minor bigint,
  status text not null check (status in ('active', 'deprecated', 'withdrawn')),
  registered_at timestamptz not null default now(),
  status_changed_at timestamptz not null default now(),
  primary key (organisation_id, id),
  constraint capabilities_approval_is_whole check (
    (approval_above_currency is null) = (approval_above_minor is null)
  ),
  constraint capabilities_approval_is_not_negative check (
    approval_above_minor is null or approval_above_minor >= 0
  ),
  constraint capabilities_currencies_are_not_empty check (
    currencies is null or cardinality(currencies) > 0
  )
);

create index if not exists capabilities_organisation_idx on capabilities (organisation_id, status);

-- Enforcement is per organisation and lives here rather than on organisations, because that row is
-- copied verbatim into every signed mandate. A catalogue setting has no business in the authority.
create table if not exists catalogue_settings (
  organisation_id text primary key references organisations (id),
  enforcement text not null check (enforcement in ('advisory', 'required')),
  changed_at timestamptz not null default now()
);

grant select, insert, update on capabilities to warrant_api;
grant select, insert, update on catalogue_settings to warrant_api;
revoke delete, truncate on capabilities from warrant_api;
revoke delete, truncate on catalogue_settings from warrant_api;
