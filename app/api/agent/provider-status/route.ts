import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSupabase } from "@/lib/supabase";
import { authenticateAgent } from "@/lib/agent-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  requestId: z.string().min(8).max(128)
});

type ProviderRequest = {
  status?: unknown;
  tx_hash?: unknown;
  result?: { tx_hash?: unknown } | null;
  error?: unknown;
};

export async function POST(request: NextRequest) {
  let identity;
  try {
    identity = await authenticateAgent(request.headers.get("authorization"));
  } catch {
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const db = getSupabase();
  const { data: reservation, error: lookupError } = await db
    .from("spend_reservations")
    .select("request_id,status,outlayer_request_id,outlayer_tx_hash,agent_id")
    .eq("request_id", parsed.data.requestId)
    .maybeSingle();

  if (lookupError) {
    return NextResponse.json({ error: "reservation_lookup_failed" }, { status: 500 });
  }
  if (!reservation) {
    return NextResponse.json({ error: "reservation_not_found" }, { status: 404 });
  }
  if (!identity.isAdmin && reservation.agent_id !== identity.agentId) {\n    return NextResponse.json({ error: "reservation_not_found" }, { status: 404 });\n  }\n  if (!reservation.outlayer_request_id) {
    return NextResponse.json({
      status: reservation.status,
      requestId: reservation.request_id,
      reason: "provider_request_id_not_available"
    }, { status: 409 });
  }
  if (reservation.status === "executed" || reservation.status === "failed") {
    return NextResponse.json({
      status: reservation.status,
      requestId: reservation.request_id,
      txHash: reservation.outlayer_tx_hash
    });
  }

  const baseUrl = process.env.OUTLAYER_BASE_URL?.replace(/\/$/, "");
  const apiKey = process.env.OUTLAYER_API_KEY;
  if (!baseUrl || !apiKey) {
    return NextResponse.json({ error: "outlayer_not_configured" }, { status: 503 });
  }

  let provider: ProviderRequest;
  let providerHttpStatus: number;

  try {
    const response = await fetch(
      `${baseUrl}/wallet/v1/requests/${encodeURIComponent(reservation.outlayer_request_id)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}` },
        cache: "no-store",
        signal: AbortSignal.timeout(15000)
      }
    );

    providerHttpStatus = response.status;
    provider = await response.json().catch(() => ({}));
    if (!response.ok) {
      return NextResponse.json({
        status: reservation.status,
        requestId: reservation.request_id,
        providerHttpStatus,
        reason: "provider_status_lookup_failed"
      }, { status: 202 });
    }
  } catch {
    return NextResponse.json({
      status: reservation.status,
      requestId: reservation.request_id,
      reason: "provider_status_lookup_unavailable"
    }, { status: 202 });
  }

  const providerStatus = typeof provider.status === "string" ? provider.status : "unrecognised";
  const candidateHash =
    typeof provider.tx_hash === "string"
      ? provider.tx_hash
      : typeof provider.result?.tx_hash === "string"
        ? provider.result.tx_hash
        : null;

  let txHash = reservation.outlayer_tx_hash;
  if (candidateHash && !txHash) {
    const { error: updateError } = await db
      .from("spend_reservations")
      .update({ outlayer_tx_hash: candidateHash })
      .eq("request_id", reservation.request_id);
    if (updateError) {
      return NextResponse.json({
        status: reservation.status,
        requestId: reservation.request_id,
        providerStatus,
        reason: "transaction_hash_persistence_failed"
      }, { status: 202 });
    }
    txHash = candidateHash;
  }

  // Provider status is informational only. Budget settlement is exclusively
  // performed by the separate NEAR FINAL transaction reconciliation route.
  return NextResponse.json({
    status: reservation.status,
    requestId: reservation.request_id,
    providerStatus,
    txHash,
    reconciliationRequired: Boolean(txHash),
    providerError: typeof provider.error === "string" ? provider.error : undefined
  }, { status: 200 });
}
