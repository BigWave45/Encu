export type OutLayerTransferBody = {
  tx_hash?: string;
  request_id?: string;
  error?: string;
  status?: string;
  [key: string]: unknown;
};

export type OutLayerTransferResult = {
  httpStatus: number;
  body: OutLayerTransferBody;
};

export async function transferNear(to: string, amount: string): Promise<OutLayerTransferResult> {
  const baseUrl = process.env.OUTLAYER_BASE_URL?.replace(/\/$/, "");
  const apiKey = process.env.OUTLAYER_API_KEY;
  if (!baseUrl || !apiKey) throw new Error("OutLayer is not configured.");

  const response = await fetch(`${baseUrl}/wallet/v1/transfer`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ to, amount }),
    cache: "no-store",
    signal: AbortSignal.timeout(30000)
  });

  const raw = await response.text();
  let body: OutLayerTransferBody = {};
  try {
    body = raw ? JSON.parse(raw) as OutLayerTransferBody : {};
  } catch {
    body = { error: "unparseable_response" };
  }
  return { httpStatus: response.status, body };
}