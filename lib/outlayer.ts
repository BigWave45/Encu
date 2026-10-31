export type OutLayerTransferBody = {
  tx_hash?: string;
  request_id?: string;
  requestId?: string;
  error?: string;
  status?: string;
  [key: string]: unknown;
};

export type OutLayerTransferResult = {
  httpStatus: number;
  body: OutLayerTransferBody;
};

export type OutLayerConfig = {
  baseUrl: string;
  apiKey: string;
  nearAddress: string;
};

const NEAR_ACCOUNT_ID = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*)$/;

export function getOutLayerConfig(): OutLayerConfig {
  const rawBaseUrl = process.env.OUTLAYER_BASE_URL;
  const apiKey = process.env.OUTLAYER_API_KEY;
  const nearAddress = process.env.OUTLAYER_NEAR_ADDRESS;

  if (!rawBaseUrl || !apiKey || !nearAddress) {
    throw new Error("outlayer_configuration_missing");
  }
  if (!NEAR_ACCOUNT_ID.test(nearAddress) || nearAddress.length < 2 || nearAddress.length > 64) {
    throw new Error("outlayer_near_address_invalid");
  }

  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new Error("outlayer_base_url_invalid");
  }

  const isOfficialTestnet = url.protocol === "https:" &&
    url.hostname === "testnet-api.outlayer.ai" &&
    !url.username && !url.password && !url.search && !url.hash && !url.port &&
    (url.pathname === "/" || url.pathname === "");

  const isLocalDevelopment = (process.env.NODE_ENV !== "production" || (process.env.CI === "true" && process.env.AGENTGUARD_TEST_MODE === "true")) &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") &&
    url.protocol === "http:" && !url.username && !url.password && !url.search && !url.hash && !url.port;

  if (!isOfficialTestnet && !isLocalDevelopment) {
    throw new Error("outlayer_testnet_endpoint_required");
  }

  return {
    baseUrl: url.toString().replace(/\/$/, ""),
    apiKey,
    nearAddress
  };
}

export function getNearTestnetRpcUrl(): string {
  const raw = process.env.NEAR_RPC_URL ?? "https://rpc.testnet.near.org";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("near_rpc_url_invalid");
  }

  const isOfficialTestnet = url.protocol === "https:" &&
    url.hostname === "rpc.testnet.near.org" &&
    !url.username && !url.password && !url.search && !url.hash;

  const isLocalDevelopment = (process.env.NODE_ENV !== "production" || (process.env.CI === "true" && process.env.AGENTGUARD_TEST_MODE === "true")) &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") &&
    url.protocol === "http:" && !url.username && !url.password && !url.search && !url.hash;

  if (!isOfficialTestnet && !isLocalDevelopment) {
    throw new Error("near_testnet_rpc_required");
  }
  return url.toString();
}

export async function transferNear(to: string, amount: string): Promise<OutLayerTransferResult> {
  const { baseUrl, apiKey } = getOutLayerConfig();
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
