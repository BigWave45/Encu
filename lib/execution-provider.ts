import { getOutLayerConfig, transferNear } from "@/lib/outlayer";

export type ExecutionTransferResponse = {
  httpStatus: number;
  body: { tx_hash?: string; request_id?: string; requestId?: string; error?: string; status?: string; [key: string]: unknown };
};

export type NativeTransfer = {
  recipient: string;
  amountYocto: string;
};

export interface ExecutionProvider {
  readonly id: string;
  assertConfigured(): void;
  verifyExecutionAccount(): Promise<void>;
  submitNativeTransfer(input: NativeTransfer): Promise<ExecutionTransferResponse>;
}

/**
 * V1 adapter. ENCU authorization, reservation and settlement remain outside
 * this adapter so the execution provider can change without changing policy.
 */
const outLayerProvider: ExecutionProvider = {
  id: "outlayer",
  assertConfigured() {
    getOutLayerConfig();
  },
  async verifyExecutionAccount() {
    const config = getOutLayerConfig();
    const response = await fetch(`${config.baseUrl}/wallet/v1/address?chain=near`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error("execution_signer_unavailable");
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    const address = body && (
      typeof body.executor_account_id === "string" ? body.executor_account_id :
      typeof body.address === "string" ? body.address :
      typeof body.near_address === "string" ? body.near_address :
      typeof body.account_id === "string" ? body.account_id : null
    );
    if (!address || address !== config.nearAddress) throw new Error("execution_signer_mismatch");
  },
  submitNativeTransfer({ recipient, amountYocto }) {
    return transferNear(recipient, amountYocto);
  }
};

export function getExecutionProvider(): ExecutionProvider {
  const provider = process.env.ENCU_EXECUTION_PROVIDER ?? "outlayer";
  if (provider === "outlayer") return outLayerProvider;
  throw new Error("execution_provider_not_configured");
}
