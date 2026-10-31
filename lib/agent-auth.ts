import { timingSafeEqual } from "node:crypto";

export type AgentIdentity = { agentId: string; isAdmin: boolean };

function safeEqual(expected: string, supplied: string) {
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function authenticateAgent(authorization: string | null): Promise<AgentIdentity | null> {
  const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : null;
  if (!supplied) return null;
  const primaryToken = process.env.AGENTGUARD_AGENT_TOKEN;
  if (primaryToken && safeEqual(primaryToken, supplied)) return { agentId: "primary", isAdmin: true };
  const secondaryToken = process.env.AGENTGUARD_AGENT_B_TOKEN;
  if (secondaryToken && safeEqual(secondaryToken, supplied)) return { agentId: "agent_b", isAdmin: false };
  return null;
}