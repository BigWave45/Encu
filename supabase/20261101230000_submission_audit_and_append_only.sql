-- Forward-only correction for databases that applied the original atomic
-- OutLayer submission migration before provider-submission auditing was added.
-- Provider acceptance remains needs_review; this function does not settle budget.
create or replace function public.record_outlayer_submission(
 p_request_id text, p_tx_hash text default null,
 p_provider_request_id text default null, p_error text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $agentguard$
declare reservation public.spend_reservations%rowtype;
begin
 perform 1 from public.agent_budgets where id = 'default' for update;
 if not found then raise exception 'budget_not_configured'; end if;
 select * into reservation from public.spend_reservations
 where request_id = p_request_id for update;
 if not found then raise exception 'reservation_not_found'; end if;
 if reservation.status not in ('reserved', 'needs_review') then
  return pg_catalog.jsonb_build_object('status', reservation.status, 'request_id', p_request_id);
 end if;
 if reservation.outlayer_tx_hash is not null and p_tx_hash is not null
    and reservation.outlayer_tx_hash <> p_tx_hash then
  raise exception 'provider_transaction_hash_conflict';
 end if;
 if reservation.outlayer_request_id is not null and p_provider_request_id is not null
    and reservation.outlayer_request_id <> p_provider_request_id then
  raise exception 'provider_request_id_conflict';
 end if;
 update public.spend_reservations as sr
 set status = 'needs_review',
     outlayer_tx_hash = coalesce(sr.outlayer_tx_hash, p_tx_hash),
     outlayer_request_id = coalesce(sr.outlayer_request_id, p_provider_request_id),
     last_error = p_error, updated_at = pg_catalog.now()
 where sr.request_id = p_request_id;
 -- Record the first transition only. Replayed provider callbacks must not
 -- manufacture duplicate audit events for the same reservation.
 if reservation.status = 'reserved' then
  insert into public.agentguard_admin_audit(actor_agent_id,action,target_id,details)
  values('system:outlayer','provider_submission_recorded',p_request_id,
    pg_catalog.jsonb_build_object('agent_id',reservation.agent_id,'tx_hash',p_tx_hash,
      'provider_request_id',p_provider_request_id,'error',p_error));
 end if;
 return pg_catalog.jsonb_build_object('status', 'needs_review', 'request_id', p_request_id);
end;
$agentguard$;
revoke all on function public.record_outlayer_submission(text,text,text,text) from public,anon,authenticated;
grant execute on function public.record_outlayer_submission(text,text,text,text) to service_role;

revoke update, delete, truncate, references, trigger
  on table public.agentguard_admin_audit from service_role;
revoke update, delete, truncate, references, trigger
  on table public.agentguard_security_events from service_role;
grant select, insert on table public.agentguard_admin_audit to service_role;
grant select, insert on table public.agentguard_security_events to service_role;
