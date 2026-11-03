-- Retire the legacy human-approval RPCs. Autonomous transfers are authorized
-- exclusively by reserve_agent_spend + claim_agent_auto_submission.
drop function if exists public.approve_agent_transfer(text, text);
drop function if exists public.reject_agent_transfer(text, text, text);
drop function if exists public.cancel_expired_agent_transfer(text, text, text);
