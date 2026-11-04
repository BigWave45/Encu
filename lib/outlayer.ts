export type OutLayerTransferBody = { tx_hash?: string; request_id?: string; requestId?: string; error?: string; status?: string; [key:string]: unknown };
export type OutLayerTransferResult = { httpStatus:number; body:OutLayerTransferBody };
export type AgentGuardNetwork = "testnet" | "mainnet";
export type OutLayerConfig = { baseUrl:string; apiKey:string; nearAddress:string; network:AgentGuardNetwork };
const NEAR_ACCOUNT_ID=/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*)$/;
function networkMode():AgentGuardNetwork {
 const n=process.env.AGENTGUARD_NETWORK ?? "testnet";
 if(n!=="testnet"&&n!=="mainnet") throw new Error("agentguard_network_invalid");
 return n;
}
function localMock(u:URL):boolean {
 const testMode=process.env.NODE_ENV!=="production"||(process.env.CI==="true"&&process.env.AGENTGUARD_TEST_MODE==="true");
 return testMode&&(u.hostname==="127.0.0.1"||u.hostname==="localhost"||u.hostname==="[::1]")&&u.protocol==="http:"&&!u.username&&!u.password&&!u.search&&!u.hash;
}
export function getOutLayerConfig():OutLayerConfig {
 const raw=process.env.OUTLAYER_BASE_URL,apiKey=process.env.OUTLAYER_API_KEY,nearAddress=process.env.OUTLAYER_NEAR_ADDRESS;
 if(!raw||!apiKey||!nearAddress) throw new Error("outlayer_configuration_missing");
 if(!NEAR_ACCOUNT_ID.test(nearAddress)||nearAddress.length<2||nearAddress.length>64) throw new Error("outlayer_near_address_invalid");
 const network=networkMode(); let url:URL;
 try{url=new URL(raw)}catch{throw new Error("outlayer_base_url_invalid")}
 const host=network==="mainnet"?"api.outlayer.ai":"testnet-api.outlayer.ai";
 const official=url.protocol==="https:"&&url.hostname===host&&!url.username&&!url.password&&!url.search&&!url.hash&&!url.port&&(url.pathname==="/"||url.pathname==="");
 if(!official&&!localMock(url)) throw new Error(network==="mainnet"?"outlayer_mainnet_endpoint_required":"outlayer_testnet_endpoint_required");
 return {baseUrl:url.toString().replace(/\/$/,""),apiKey,nearAddress,network};
}
export function getNearRpcUrl():string {
 const network=networkMode();
 const raw=process.env.NEAR_RPC_URL??(network==="mainnet"?"https://rpc.mainnet.near.org":"https://rpc.testnet.near.org");
 let url:URL;try{url=new URL(raw)}catch{throw new Error("near_rpc_url_invalid")}
 const host=network==="mainnet"?"rpc.mainnet.near.org":"rpc.testnet.near.org";
 const official=url.protocol==="https:"&&url.hostname===host&&!url.username&&!url.password&&!url.search&&!url.hash&&!url.port&&(url.pathname==="/"||url.pathname==="");
 if(!official&&!localMock(url)) throw new Error(network==="mainnet"?"near_mainnet_rpc_required":"near_testnet_rpc_required");
 return url.toString();
}
export async function transferNear(to:string,amount:string):Promise<OutLayerTransferResult>{
 const {baseUrl,apiKey}=getOutLayerConfig();
 const response=await fetch(`${baseUrl}/wallet/v1/transfer`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${apiKey}`},body:JSON.stringify({to,amount}),cache:"no-store",signal:AbortSignal.timeout(30000)});
 const raw=await response.text();let body:OutLayerTransferBody={};
 try{body=raw?JSON.parse(raw) as OutLayerTransferBody:{}}catch{body={error:"unparseable_response"}}
 return {httpStatus:response.status,body};
}
