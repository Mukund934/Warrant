-- 007 added these as ordinary columns filled by the application. That makes correctness depend on
-- deploy ordering: any pack written by an older instance between the migration and the release has
-- them null, and is then invisible to a filter that uses them. Generated columns are computed by
-- Postgres from the document itself, so they are right no matter which build inserted the row.
--
-- A generated column cannot be written to, so the application must stop supplying them.

drop index if exists evidence_counterparty_idx;
drop index if exists evidence_action_idx;

alter table evidence_packs drop column if exists action;
alter table evidence_packs drop column if exists resource;
alter table evidence_packs drop column if exists counterparty;
alter table evidence_packs drop column if exists actor;

alter table evidence_packs
  add column action text generated always as (document -> 'request' ->> 'action') stored;
alter table evidence_packs
  add column resource text generated always as (document -> 'request' ->> 'resource') stored;
alter table evidence_packs
  add column counterparty text generated always as (document -> 'request' ->> 'counterparty') stored;
alter table evidence_packs
  add column actor text generated always as (document -> 'request' ->> 'actor') stored;

create index if not exists evidence_counterparty_idx
  on evidence_packs (organisation_id, counterparty, evaluated_at desc);

create index if not exists evidence_action_idx
  on evidence_packs (organisation_id, action, evaluated_at desc);
