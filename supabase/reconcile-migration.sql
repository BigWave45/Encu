-- Existing installations only: run once in Supabase SQL Editor.
-- This allows an independently confirmed transaction to settle a
-- reservation that was previously marked needs_review.

create or replace function public.finish_agent_spend(
  p_request_id text,
  p_outcome text,
  p_tx_hash text default null,
  p_error text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  reservation public.spend_reservations%rowtype;
begin
  if p_outcome not in ('executed', 'failed', 'needs_review') then
    raise exception 'invalid_outcome';
  end if;

  perform 1 from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;

  select * into reservation
  from public.spend_reservations
  where request_id = p_request_id
  for update;

  if not found then raise exception 'reservation_not_found'; end if;

  if reservation.status not in ('reserved', 'needs_review') then
    return jsonb_build_object('status', reservation.status, 'request_id', p_request_id);
  end if;

  if p_outcome = 'executed' then
    update public.agent_budgets
    set reserved_yocto = reserved_yocto - reservation.amount_yocto,
        spent_yocto = spent_yocto + reservation.amount_yocto,
        updated_at = now()
    where id = 'default';
  elsif p_outcome = 'failed' then
    update public.agent_budgets
    set reserved_yocto = reserved_yocto - reservation.amount_yocto,
        updated_at = now()
    where id = 'default';
  end if;

  update public.spend_reservations
  set status = p_outcome,
      outlayer_tx_hash = coalesce(p_tx_hash, outlayer_tx_hash),
      last_error = p_error,
      updated_at = now()
  where request_id = p_request_id;

  return jsonb_build_object('status', p_outcome, 'request_id', p_request_id);
end;
$$;

revoke all on function public.finish_agent_spend(text, text, text, text) from public;
grant execute on function public.finish_agent_spend(text, text, text, text) to service_role;
