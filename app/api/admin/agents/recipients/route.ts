import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateAdmin } from "@/lib/agent-auth";
import { getSupabase } from "@/lib/supabase";
import { adminRateLimitResponse } from "@/lib/admin-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const agentId = z.string().min(2).max(48).regex(/^[a-z0-9_-]+$/);
const accountId = z.string().min(2).max(64).regex(/^[a-z0-9]+([._-][a-z0-9]+)*$/);
const authorizeSchema = z.object({
  agentId,
  accountId,
  label: z.string().trim().max(80).nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional()
});
const revokeSchema = z.object({
  agentId,
  accountId,
  reason: z.string().trim().min(3).max(500)
});

function admin(request: NextRequest) {
  try {
    const identity = authenticateAdmin(request.headers.get("authorization"));
    return identity?.isAdmin ? identity : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const identity = admin(request);
  if (!identity) return NextResponse.json({ error: "admin_required" }, { status: 403 });
  const parsed = authorizeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 });

  const limited = await adminRateLimitResponse(identity.agentId, "recipient_authorize", 20, 60);
  if (limited) return limited;

  const { data, error } = await getSupabase().rpc("authorize_agent_recipient", {
    p_agent_id: parsed.data.agentId,
    p_account_id: parsed.data.accountId,
    p_label: parsed.data.label ?? null,
    p_expires_at: parsed.data.expiresAt ?? null,
    p_actor_agent_id: identity.agentId
  });
  if (error) {
    const message = error.message ?? "";
    if (message.includes("agent_allocation_not_configured")) return NextResponse.json({ error: "agent_not_found" }, { status: 404 });
    if (message.includes("recipient_authorization_not_found")) return NextResponse.json({ error: "recipient_authorization_not_found" }, { status: 404 });
    if (message.includes("invalid_recipient_authorization")) return NextResponse.json({ error: "invalid_recipient_authorization" }, { status: 400 });
    return NextResponse.json({ error: "recipient_authorization_failed" }, { status: 500 });
  }
  return NextResponse.json({ status: "authorized", recipient: data }, {
    headers: { "Cache-Control": "no-store, private" }
  });
}

export async function DELETE(request: NextRequest) {
  const identity = admin(request);
  if (!identity) return NextResponse.json({ error: "admin_required" }, { status: 403 });
  const parsed = revokeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 });

  const limited = await adminRateLimitResponse(identity.agentId, "recipient_revoke", 20, 60);
  if (limited) return limited;

  const { data, error } = await getSupabase().rpc("revoke_agent_recipient", {
    p_agent_id: parsed.data.agentId,
    p_account_id: parsed.data.accountId,
    p_reason: parsed.data.reason,
    p_actor_agent_id: identity.agentId
  });
  if (error) {
    const message = error.message ?? "";
    if (message.includes("recipient_authorization_not_found")) return NextResponse.json({ error: "recipient_authorization_not_found" }, { status: 404 });
    if (message.includes("invalid_recipient_revocation")) return NextResponse.json({ error: "invalid_recipient_revocation" }, { status: 400 });
    return NextResponse.json({ error: "recipient_revocation_failed" }, { status: 500 });
  }
  return NextResponse.json({ status: "revoked", recipient: data }, {
    headers: { "Cache-Control": "no-store, private" }
  });
}
