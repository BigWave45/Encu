import { NextResponse } from "next/server";
import { consumeRateLimit } from "@/lib/rate-limit";
import { recordSecurityEvent } from "@/lib/security-audit";

export async function agentRateLimitResponse(
  actorAgentId: string,
  action: string,
  limit = 20,
  windowSeconds = 60
): Promise<NextResponse | null> {
  let result: Awaited<ReturnType<typeof consumeRateLimit>>;
  try {
    result = await consumeRateLimit(`agent:${actorAgentId}`, action, limit, windowSeconds);
  } catch {
    result = null;
  }
  if (!result) {
    return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  }
  if (result.allowed) return null;

  const recorded = await recordSecurityEvent({
    actorAgentId,
    eventType: "agent_rate_limited",
    details: { action, retryAfterSeconds: result.retryAfterSeconds }
  });
  if (!recorded) {
    return NextResponse.json({ error: "security_event_unavailable" }, { status: 503 });
  }

  return NextResponse.json(
    { error: "rate_limit_exceeded", retryAfterSeconds: result.retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } }
  );
}
