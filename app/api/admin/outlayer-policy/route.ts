import { NextRequest, NextResponse } from "next/server";
import { authenticateAdmin } from "@/lib/agent-auth";
import { getOutLayerConfig } from "@/lib/outlayer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

export async function GET(request: NextRequest) {
  let identity: ReturnType<typeof authenticateAdmin>;
  try {
    identity = authenticateAdmin(request.headers.get("authorization"));
  } catch {
    return NextResponse.json({ error: "authentication_unavailable" }, { status: 503 });
  }
  if (!identity?.isAdmin) {
    return NextResponse.json({ error: "admin_required" }, { status: 403 });
  }

  let config: ReturnType<typeof getOutLayerConfig>;
  try {
    config = getOutLayerConfig();
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "outlayer_configuration_invalid"
    }, { status: 503 });
  }

  try {
    const addressResponse = await fetch(`${config.baseUrl}/wallet/v1/address?chain=near`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10000)
    });
    if (!addressResponse.ok) {
      return NextResponse.json({ error: "outlayer_signer_unavailable" }, { status: 503 });
    }
    const addressBody = asObject(await addressResponse.json().catch(() => null));
    const actualAddress = addressBody && (
      typeof addressBody.executor_account_id === "string" ? addressBody.executor_account_id :
      typeof addressBody.address === "string" ? addressBody.address :
      typeof addressBody.near_address === "string" ? addressBody.near_address :
      typeof addressBody.account_id === "string" ? addressBody.account_id : null
    );
    if (!actualAddress || actualAddress !== config.nearAddress) {
      return NextResponse.json({ error: "outlayer_signer_mismatch" }, { status: 503 });
    }

    const response = await fetch(`${config.baseUrl}/wallet/v1/policy`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15000)
    });
    const raw = await response.json().catch(() => null);
    if (!response.ok) {
      return NextResponse.json({
        error: "outlayer_policy_lookup_failed",
        providerHttpStatus: response.status
      }, { status: 502 });
    }

    const outer = asObject(raw);
    const policy = asObject(outer?.policy) ?? outer;
    if (!policy) {
      return NextResponse.json({ error: "outlayer_policy_response_invalid" }, { status: 502 });
    }

    // Return only effective policy fields needed for the AgentGuard security review.
    // Never proxy API keys, raw wallet metadata, or unrelated provider response fields.
    return NextResponse.json({
      status: "ok",
      network: config.network,
      executorAddress: actualAddress,
      policy: {
        rules: policy.rules ?? null,
        capabilities: policy.capabilities ?? null,
        approval: policy.approval ?? null,
        updatedAt: policy.updated_at ?? policy.updatedAt ?? null,
        version: policy.version ?? null
      }
    }, { headers: { "Cache-Control": "no-store, private" } });
  } catch {
    return NextResponse.json({ error: "outlayer_policy_lookup_unavailable" }, { status: 503 });
  }
}
