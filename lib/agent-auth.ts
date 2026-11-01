import { createHash, timingSafeEqual } from "node:crypto";
import { getSupabase } from "@/lib/supabase";

export type AgentIdentity = {
  agentId: string;
  isAdmin: boolean;
};

function safeEqual(expected: string, supplied: string) {
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(authorization: string | null) {
  return authorization?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
}

export async function authenticateAgent(authorization: string | null): Promise<AgentIdentity | null> {
  const supplied = bearerToken(authorization);
  if (!supplied) return null;

  // The primary agent credential is an agent credential only. It never grants
  // administrator privileges.
  const primaryToken = process.env.AGENTGUARD_AGENT_TOKEN;
  if (primaryToken && safeEqual(primaryToken, supplied)) {
    return { agentId: "primary", isAdmin: false };
  }

  const tokenHash = createHash("sha256").update(supplied).digest("hex");
  const { data, error } = await getSupabase()
    .from("agents")
    .select("id,active")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error) throw new Error("agent_authentication_lookup_failed");
  if (!data || data.active !== true) return null;
  return { agentId: data.id, isAdmin: false };
}

export function authenticateAdmin(authorization: string | null): AgentIdentity | null {
  const supplied = bearerToken(authorization);
  const adminToken = process.env.AGENTGUARD_ADMIN_TOKEN;
  if (!supplied || !adminToken || !safeEqual(adminToken, supplied)) return null;

  // Keep the existing primary audit actor identity, but this credential cannot
  // be used by agent endpoints.
  return { agentId: "primary", isAdmin: true };
}
