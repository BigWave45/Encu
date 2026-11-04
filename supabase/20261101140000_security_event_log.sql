create table if not exists public.agentguard_security_events (
  id uuid primary key default gen_random_uuid(),
  actor_agent_id text,
  event_type text not null,
  request_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists agentguard_security_events_created_at_idx
  on public.agentguard_security_events (created_at desc);
create index if not exists agentguard_security_events_actor_created_at_idx
  on public.agentguard_security_events (actor_agent_id, created_at desc);

alter table public.agentguard_security_events enable row level security;
revoke all on public.agentguard_security_events from public, anon, authenticated;
grant select, insert on public.agentguard_security_events to service_role;
