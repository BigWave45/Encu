export type OutLayerTransferResult = {
  status?: string;
  tx_hash?: string;
  request_id?: string;
  [key: string]: unknown;
};

export async function transferNear(to: string, amount: string) {
  const baseUrl = process.env.OUTLAYER_BASE_URL?.replace(/\/$/, "");
  const apiKey = process.env.OUTLAYER_API_KEY;

  if (!baseUrl || !apiKey) {
    throw new Error("OutLayer is not configured. Set its testnet URL and API key.");
  }

  const response = await fetch(`${baseUrl}/wallet/v1/transfer`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ to, amount }),
    cache: "no-store"
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(`OutLayer rejected the transfer (${response.status}): ${JSON.stringify(body)}`);
  }

  return body as OutLayerTransferResult;
}