-- Persist OutLayer's asynchronous request reference for safe follow-up.
alter table public.spend_reservations
  add column if not exists outlayer_request_id text;
