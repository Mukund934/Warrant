-- The ceiling above every mandate an organisation issues. It lives here rather than on the
-- organisations row because that row is copied verbatim into every signed mandate, and a policy
-- setting has no business inside the authority.
create table if not exists house_scopes (
  organisation_id text primary key references organisations (id),
  scope jsonb,
  set_at timestamptz not null default now()
);

grant select, insert, update on house_scopes to warrant_api;
revoke delete, truncate on house_scopes from warrant_api;
