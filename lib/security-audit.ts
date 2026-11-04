import { getSupabase } from "@/lib/supabase";

type SecurityEvent = {
  actorAgentId?: string | null;
  eventType: string;
  requestId?: string | null;
  details?: Record<string, string | number | boolean | null>;
};

export async function recordSecurityEvent(event: SecurityEvent): Promise<boolean> {
  try {
    const { error } = await getSupabase().from("agentguard_security_events").insert({
      actor_agent_id: event.actorAgentId ?? null,
      event_type: event.eventType,
      request_id: event.requestId ?? null,
      details: event.details ?? {}
    });
    return !error;
  } catch {
    // Audit persistence must never turn a safe rejection into an unsafe retry.
    return false;
  }
}
