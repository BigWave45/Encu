-- Defer autonomous submission claims until the provider boundary.
-- A claim and a recipient revocation use the same lock order:
-- treasury -> agent allocation -> recipient -> reservation.
begin;

create or replace function public.defer_agent_auto_submission_claim()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.auto_approved = true and new.status = 'reserved' then
    new.submission_claimed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists defer_agent_auto_submission_claim on public.spend_reservations;
create trigger defer_agent_auto_submission_claim
before insert on public.spend_reservations
for each row execute function public.defer_agent_auto_submission_claim();

create or replace function public.claim_agent_auto_submission(
  p_request_id text,
  p_agent_id text,
  p_recipient text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allocation public.agent_allocations%rowtype;
  v_recipient public.agent_authorized_recipients%rowtype;
  v_reservation public.spend_reservations%rowtype;
  v_enabled boolean;
  v_active boolean;
begin
  if p_request_id is null or p_agent_id is null or p_recipient is null then
    raise exception 'invalid_submission_claim';
  end if;

  perform 1 from public.agent_budgets where id = 'default' for update;
  if not found then raise exception 'budget_not_configured'; end if;

  select * into v_allocation
  from public.agent_allocations
  where agent_id = p_agent_id
  for update;
  if not found then raise exception 'agent_allocation_not_configured'; end if;

  select * into v_recipient
  from public.agent_authorized_recipients
  where agent_id = p_agent_id and account_id = p_recipient
  for update;
  if not found or v_recipient.status <> 'active'
     or (v_recipient.expires_at is not null and v_recipient.expires_at <= pg_catalog.now()) then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'recipient_not_authorized');
  end if;

  select * into v_reservation
  from public.spend_reservations
  where request_id = p_request_id
  for update;
  if not found or v_reservation.agent_id <> p_agent_id
     or v_reservation.recipient <> p_recipient
     or v_reservation.status <> 'reserved'
     or v_reservation.auto_approved is distinct from true then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'reservation_not_claimable');
  end if;

  if v_reservation.submission_claimed_at is not null then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'already_claimed');
  end if;

  select transfers_enabled into v_enabled
  from public.agentguard_system_controls
  where id = 'default'
  for share;
  if not coalesce(v_enabled, false) then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'emergency_stop');
  end if;

  select active into v_active from public.agents where id = p_agent_id for share;
  if not coalesce(v_active, false) then
    return pg_catalog.jsonb_build_object('claimed', false, 'reason', 'agent_not_active');
  end if;

  update public.spend_reservations
  set submission_claimed_at = pg_catalog.now(), updated_at = pg_catalog.now()
  where request_id = p_request_id;

  insert into public.agentguard_admin_audit(actor_agent_id, action, target_id, details)
  values(p_agent_id, 'transfer_submission_claimed', p_request_id,
    pg_catalog.jsonb_build_object('recipient', p_recipient, 'amount_yocto', v_reservation.amount_yocto::text));

  return pg_catalog.jsonb_build_object('claimed', true, 'request_id', p_request_id);
end;
$$;

revoke all on function public.claim_agent_auto_submission(text,text,text) from public, anon, authenticated;
grant execute on function public.claim_agent_auto_submission(text,text,text) to service_role;

commit;
