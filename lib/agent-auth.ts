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

export async function authenticateAgent(authorization: string | null): Promise<AgentIdentity | null> {
  const supplied = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!supplied) return null;

  const primaryToken = process.env.AGENTGUARD_AGENT_TOKEN;
  if (primaryToken && safeEqual(primaryToken, supplied)) {
    return { agentId: "primary", isAdmin: true };
  }

  const secondaryToken = process.env.AGENTGUARD_AGENT_B_TOKEN;
  if (secondaryToken && safeEqual(secondaryToken, supplied)) {
    return { agentId: "agent_b", isAdmin: false };
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
