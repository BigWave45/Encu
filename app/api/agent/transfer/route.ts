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
  amountYocto: z.string().max(78).regex(/^[1-9][0-9]*$/),
  expectedAgentId: z.string().min(2).max(48).regex(/^[a-z0-9_-]+$/).optional()
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

  if (parsed.data.expectedAgentId && parsed.data.expectedAgentId !== identity.agentId) {
    return NextResponse.json({ status: "blocked", created: false, reason: "agent_identity_mismatch", expectedAgentId: parsed.data.expectedAgentId, authenticatedAgentId: identity.agentId }, { status: 409 });
  }

  let rateLimit: Awaited<ReturnType<typeof consumeRateLimit>>;
  try {
    rateLimit = await consumeRateLimit(`agent:${identity.agentId}`, "transfer_prepare", 20, 60);
  } catch {
    rateLimit = null;
  }
  if (!rateLimit) return NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 });
  if (!rateLimit.allowed) {
    const recorded = await recordSecurityEvent({ actorAgentId: identity.agentId, eventType: "transfer_rate_limited" });
    if (!recorded) return NextResponse.json({ error: "security_event_unavailable" }, { status: 503 });
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
    return NextResponse.json({ status: "blocked", reason: "per_transaction_limit", agentId: identity.agentId, created: false }, { status: 403 });
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
    return NextResponse.json({ ...reservation, agentId: identity.agentId }, { status: 403 });
  }

  if (reservation?.created === true && reservation.status === "awaiting_approval") {
    return NextResponse.json({
      status: "awaiting_approval",
      agentId: identity.agentId,
      requestId,
      approvalExpiresAt: reservation.approval_expires_at ?? null
    }, { status: 202 });
  }

  // Only a newly-created, policy-authorized reservation can reach the provider.
  // Idempotent replays never submit a second provider request.
  if (reservation?.created !== true || reservation.status !== "reserved" || reservation.auto_approved !== true) {
    await recordSecurityEvent({ actorAgentId: identity.agentId, eventType: "transfer_replay_rejected", requestId });
    return NextResponse.json({
      status: reservation?.status ?? "already_processed",
      agentId: identity.agentId,
      requestId
    }, { status: 409 });
  }

  const { data: recipientGrant, error: recipientError } = await db
    .from("agent_authorized_recipients")
    .select("status,expires_at")
    .eq("agent_id", identity.agentId)
    .eq("account_id", to)
    .maybeSingle();
  if (recipientError || !recipientGrant || recipientGrant.status !== "active" ||
      (recipientGrant.expires_at && Date.parse(recipientGrant.expires_at) <= Date.now())) {
    await db.rpc("finish_agent_spend", {
      p_request_id: requestId, p_outcome: "failed", p_tx_hash: null, p_error: "recipient_authorization_changed_before_submission"
    });
    await recordSecurityEvent({
      actorAgentId: identity.agentId, eventType: "transfer_auto_submission_blocked",
      requestId, details: { reason: "recipient_not_authorized_at_submission" }
    });
    return NextResponse.json({ status: "blocked", reason: "recipient_not_authorized" }, { status: 403 });
  }

  let config: ReturnType<typeof getOutLayerConfig>;
  try {
    config = getOutLayerConfig();
    const addressResponse = await fetch(`${config.baseUrl}/wallet/v1/address?chain=near`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10000)
    });
    if (!addressResponse.ok) throw new Error("outlayer_signer_unavailable");
    const addressBody = await addressResponse.json().catch(() => null) as Record<string, unknown> | null;
    const actualAddress = addressBody && (
      typeof addressBody.executor_account_id === "string" ? addressBody.executor_account_id :
      typeof addressBody.address === "string" ? addressBody.address :
      typeof addressBody.near_address === "string" ? addressBody.near_address :
      typeof addressBody.account_id === "string" ? addressBody.account_id : null
    );
    if (!actualAddress || actualAddress !== config.nearAddress) throw new Error("outlayer_signer_mismatch");
  } catch (error) {
    const reason = error instanceof Error ? error.message : "outlayer_signer_unavailable";
    await db.rpc("finish_agent_spend", {
      p_request_id: requestId, p_outcome: "needs_review", p_tx_hash: null, p_error: reason
    });
    return NextResponse.json({ status: "needs_review", requestId, reason }, { status: 202 });
  }

  let txHash: string | null = null;
  let providerRequestId: string | null = null;
  let reason = "outlayer_response_unknown";
  try {
    const result = await transferNear(to, amountYocto);
    txHash = typeof result.body.tx_hash === "string" ? result.body.tx_hash : null;
    providerRequestId = typeof result.body.request_id === "string"
      ? result.body.request_id
      : typeof result.body.requestId === "string" ? result.body.requestId : null;
    if (result.httpStatus >= 200 && result.httpStatus < 300 && txHash) {
      reason = "awaiting_onchain_confirmation";
    } else if (result.httpStatus === 422 && result.body.error === "onchain_tx_failed" && txHash) {
      reason = "awaiting_onchain_confirmation_after_provider_revert";
    } else if (result.httpStatus >= 200 && result.httpStatus < 300 && providerRequestId) {
      reason = "unverified_native_transfer_response";
    } else {
      reason = `unclassified_outlayer_response_${result.httpStatus}`;
    }
  } catch {
    reason = "outlayer_timeout_or_connection_error";
  }

  let ledgerError: { message: string } | null = null;
  if (txHash || providerRequestId) {
    const { error: writeError } = await db.rpc("record_outlayer_submission", {
      p_request_id: requestId, p_tx_hash: txHash,
      p_provider_request_id: providerRequestId, p_error: reason
    });
    ledgerError = writeError;
  } else {
    const { error: writeError } = await db.rpc("finish_agent_spend", {
      p_request_id: requestId, p_outcome: "needs_review",
      p_tx_hash: null, p_error: reason
    });
    ledgerError = writeError;
  }

  await recordSecurityEvent({
    actorAgentId: identity.agentId, eventType: "transfer_auto_submitted",
    requestId, details: { providerRequestId, txHash, reason }
  });

  return NextResponse.json({
    status: "needs_review",
    agentId: identity.agentId,
    requestId,
    txHash,
    providerRequestId,
    reason: ledgerError ? "ledger_finalisation_failed" : reason
  }, { status: 202 });
}
