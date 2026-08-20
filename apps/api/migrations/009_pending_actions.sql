-- An action that escalated and is waiting for a human. The signed request is stored verbatim,
-- because an approval binds to its digest: rebuilding it from columns would change the bytes and no
-- approval would ever match.
--
-- `status` is what makes a resume happen at most once. The nonce was claimed when the action was
-- parked, so the pending row now holds that claim; a conditional update from 'pending' is what stops
-- the same parked action being spent twice.
create table if not exists pending_actions (
  id text primary key,
  organisation_id text not null references organisations (id),
  mandate_id text not null,
  request_digest text not null,
  request jsonb not null,
  reason text not null,
  pack_id text,
  status text not null check (status in ('pending', 'resumed', 'expired')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  resolved_at timestamptz,
  constraint pending_resolution_is_complete
    check ((status = 'pending') = (resolved_at is null))
);

create index if not exists pending_actions_open_idx
  on pending_actions (organisation_id, created_at desc) where status = 'pending';

grant select, insert, update on pending_actions to warrant_api;
revoke delete, truncate on pending_actions from warrant_api;
