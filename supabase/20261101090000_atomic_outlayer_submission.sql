create or replace function public.record_outlayer_submission(
 p_request_id text, p_tx_hash text default null,
 p_provider_request_id text default null, p_error text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $agentguard$
declare
 reservation public.spend_reservations%rowtype;
begin
 perform 1 from public.agent_budgets where id = 'default' for update;
 if not found then raise exception 'budget_not_configured'; end if;

 select * into reservation
 from public.spend_reservations
 where request_id = p_request_id
 for update;
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
     last_error = p_error,
     updated_at = pg_catalog.now()
 where sr.request_id = p_request_id;

 return pg_catalog.jsonb_build_object('status', 'needs_review', 'request_id', p_request_id);
end;
$agentguard$;
revoke all on function public.record_outlayer_submission(text,text,text,text) from public,anon,authenticated;
grant execute on function public.record_outlayer_submission(text,text,text,text) to service_role;
