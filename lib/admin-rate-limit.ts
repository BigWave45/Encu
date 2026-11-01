import { NextResponse } from "next/server";
import { consumeRateLimit } from "@/lib/rate-limit";
import { recordSecurityEvent } from "@/lib/security-audit";

export async function adminRateLimitResponse(
  actorAgentId: string,
  action: string,
  limit = 20,
  windowSeconds = 60
): Promise<NextResponse | null> {
  const result = await consumeRateLimit(`admin:${actorAgentId}`, action, limit, windowSeconds);
  if (!result) {
    return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  }
  if (result.allowed) return null;

  await recordSecurityEvent({
    actorAgentId,
    eventType: "admin_rate_limited",
    details: { action, retryAfterSeconds: result.retryAfterSeconds }
  });

  return NextResponse.json(
    { error: "rate_limit_exceeded", retryAfterSeconds: result.retryAfterSeconds },
    { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } }
  );
}
