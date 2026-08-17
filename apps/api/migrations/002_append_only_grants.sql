do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'warrant_api') then
    create role warrant_api nologin;
  end if;
end
$$;

grant usage on schema public to warrant_api;

grant select, insert, update on mandates to warrant_api;
grant select, insert on evidence_packs to warrant_api;
grant select, insert on ledger_entries to warrant_api;
grant select, insert, delete on nonces to warrant_api;

revoke update, delete, truncate on ledger_entries from warrant_api;
revoke update, delete, truncate on evidence_packs from warrant_api;
revoke truncate on mandates from warrant_api;
revoke delete on mandates from warrant_api;
