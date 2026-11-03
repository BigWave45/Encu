-- Diagnostic probe only; do not apply.
create table public.agent_allocations (agent_id text primary key references public.agents(id));
