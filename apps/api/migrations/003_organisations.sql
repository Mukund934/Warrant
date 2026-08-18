create table if not exists organisations (
  id text primary key,
  name text not null,
  jurisdiction text not null,
  created_at timestamptz not null default now()
);

insert into organisations (id, name, jurisdiction)
values ('org:meridian-technologies', 'Meridian Technologies Pvt Ltd', 'IN-MH')
on conflict (id) do nothing;

create table if not exists accounts (
  id text primary key,
  issuer text not null,
  subject text not null,
  email text,
  created_at timestamptz not null default now(),
  constraint accounts_identity_is_unique unique (issuer, subject)
);

create table if not exists memberships (
  organisation_id text not null references organisations (id),
  account_id text not null references accounts (id),
  role text not null check (role in ('owner', 'admin', 'member', 'auditor')),
  granted_at timestamptz not null default now(),
  primary key (organisation_id, account_id)
);

create index if not exists memberships_account_idx on memberships (account_id);

alter table evidence_packs add column if not exists organisation_id text;

alter table evidence_packs disable trigger evidence_packs_are_append_only;

update evidence_packs
set organisation_id = mandates.organisation_id
from mandates
where evidence_packs.organisation_id is null
  and mandates.id = evidence_packs.root_mandate_id;

update evidence_packs
set organisation_id = 'org:meridian-technologies'
where organisation_id is null;

alter table evidence_packs enable trigger evidence_packs_are_append_only;

alter table evidence_packs alter column organisation_id set not null;

do $$
begin
  alter table mandates add constraint mandates_belong_to_an_organisation
    foreign key (organisation_id) references organisations (id);
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  alter table evidence_packs add constraint evidence_belongs_to_an_organisation
    foreign key (organisation_id) references organisations (id);
exception
  when duplicate_object then null;
end
$$;

create index if not exists evidence_organisation_idx
  on evidence_packs (organisation_id, evaluated_at desc);

grant select, insert, update on organisations to warrant_api;
grant select, insert, update on accounts to warrant_api;
grant select, insert, update, delete on memberships to warrant_api;
revoke truncate on organisations, accounts, memberships from warrant_api;
