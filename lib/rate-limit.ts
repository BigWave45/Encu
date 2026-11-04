import { getSupabase } from "@/lib/supabase";

export async function consumeRateLimit(
  actorKey: string,
  actionKey: string,
  limit: number,
  windowSeconds = 60
): Promise<{ allowed: boolean; retryAfterSeconds: number } | null> {
  const { data, error } = await getSupabase().rpc("consume_agentguard_rate_limit", {
    p_actor_key: actorKey,
    p_action_key: actionKey,
    p_limit: limit,
    p_window_seconds: windowSeconds
  });
  if (error || !data || typeof data.allowed !== "boolean") return null;
  return {
    allowed: data.allowed,
    retryAfterSeconds: Number.isInteger(data.retry_after_seconds)
      ? Math.max(1, data.retry_after_seconds)
      : windowSeconds
  };
}
