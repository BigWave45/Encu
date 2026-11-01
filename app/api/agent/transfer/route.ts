import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import { getOutLayerConfig } from "@/lib/outlayer";
import { authenticateAgent } from "@/lib/agent-auth";
import { recordSecurityEvent } from "@/lib/security-audit";
import { consumeRateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  requestId: z.string().min(8).max(128),
  to: z.string().min(2).max(64).regex(/^[a-z0-9]+([._-][a-z0-9]+)*$/),
  amountYocto: z.string().max(78).regex(/^[1-9][0-9]*$/)
});

export async function POST(request: NextRequest) {
  let identity: Awaited<ReturnType<typeof authenticateAgent>>;
  try {
    identity = await authenticateAgent(request.headers.get("authorization"));
  } catch {
    await recordSecurityEvent({ eventType: "transfer_authentication_unavailable" });
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity) {
    await recordSecurityEvent({ eventType: "transfer_unauthorized" });
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    await recordSecurityEvent({ actorAgentId: identity.agentId, eventType: "transfer_invalid_request" });
    return NextResponse.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 });
  }

  let rateLimit: Awaited<ReturnType<typeof consumeRateLimit>>;
  try {
    rateLimit = await consumeRateLimit(`agent:${identity.agentId}`, "transfer_prepare", 60, 60);
  } catch {
    rateLimit = null;
  }
  if (!rateLimit) return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  if (!rateLimit.allowed) {
    await recordSecurityEvent({ actorAgentId: identity.agentId, eventType: "transfer_rate_limited" });
    return NextResponse.json(
      { error: "rate_limit_exceeded", retryAfterSeconds: rateLimit.retryAfterSeconds },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
    );
  }

  // Reject malformed provider/network configuration before reserving funds.
  // This only validates configuration; the provider is called after admin approval.
  try {
    getOutLayerConfig();
  } catch (error) {
    const reason = error instanceof Error ? error.message : "outlayer_configuration_invalid";
    await recordSecurityEvent({ actorAgentId: identity.agentId, eventType: "transfer_provider_configuration_blocked" });
    return NextResponse.json({ error: reason }, { status: 503 });
  }

  const { requestId, to, amountYocto } = parsed.data;
  const amount = BigInt(amountYocto);
  const cap = BigInt(process.env.AGENTGUARD_MAX_TRANSFER_YOCTO ?? "0");
  if (cap <= 0n || amount > cap) {
    await recordSecurityEvent({ actorAgentId: identity.agentId, eventType: "transfer_per_transaction_limit_blocked", requestId });
    return NextResponse.json({ status: "blocked", reason: "per_transaction_limit" }, { status: 403 });
  }

  const db = getSupabase();
  const { data: reservation, error } = await db.rpc("reserve_agent_spend", {
    p_request_id: requestId,
    p_amount_yocto: amountYocto,
    p_recipient: to,
    p_agent_id: identity.agentId
  });
  if (error) {
    const conflict = error.message.includes("idempotency_key_conflict");
    await recordSecurityEvent({
      actorAgentId: identity.agentId,
      eventType: conflict ? "transfer_idempotency_conflict" : "transfer_reservation_error",
      requestId
    });
    return NextResponse.json(
      { error: conflict ? "idempotency_key_conflict" : "reservation_failed" },
      { status: conflict ? 409 : 500 }
    );
  }

  if (reservation?.status === "blocked") {
    await recordSecurityEvent({
      actorAgentId: identity.agentId,
      eventType: "transfer_policy_blocked",
      requestId,
      details: { reason: reservation.reason ?? "policy_denied" }
    });
    return NextResponse.json(reservation, { status: 403 });
  }

  // V1 never calls OutLayer from an agent request. Every transfer waits for
  // administrator approval; only the admin approval endpoint can submit it.
  if (reservation?.created === true && reservation.status === "awaiting_approval") {
    return NextResponse.json({
      status: "awaiting_approval",
      requestId,
      approvalExpiresAt: reservation.approval_expires_at ?? null
    }, { status: 202 });
  }

  await recordSecurityEvent({ actorAgentId: identity.agentId, eventType: "transfer_replay_rejected", requestId });
  return NextResponse.json({
    status: reservation?.status ?? "already_processed",
    requestId
  }, { status: 409 });
}
