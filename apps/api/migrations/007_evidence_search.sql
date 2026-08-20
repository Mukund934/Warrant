-- Derived from the stored document, never added to it. A signed pack is unchanged; these columns
-- exist only so the questions an auditor actually asks can be answered by an index.
alter table evidence_packs add column if not exists action text;
alter table evidence_packs add column if not exists resource text;
alter table evidence_packs add column if not exists counterparty text;
alter table evidence_packs add column if not exists actor text;

alter table evidence_packs disable trigger evidence_packs_are_append_only;

update evidence_packs
set action = document -> 'request' ->> 'action',
    resource = document -> 'request' ->> 'resource',
    counterparty = document -> 'request' ->> 'counterparty',
    actor = document -> 'request' ->> 'actor'
where action is null;

alter table evidence_packs enable trigger evidence_packs_are_append_only;

-- Ordered by the pair the API paginates on, so a page boundary stays stable while writes continue.
create index if not exists evidence_search_idx
  on evidence_packs (organisation_id, evaluated_at desc, pack_id desc);

create index if not exists evidence_counterparty_idx
  on evidence_packs (organisation_id, counterparty, evaluated_at desc);

create index if not exists evidence_action_idx
  on evidence_packs (organisation_id, action, evaluated_at desc);
