"use client";
import { useState } from "react";
const YOCTO = 10n ** 24n;
function parseNear(value: string): string | null {
  const input=value.trim();
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$/.test(input)) return null;
  const [whole,fraction=""]=input.split(".");
  const amount=BigInt(whole)*YOCTO+BigInt((fraction+"0".repeat(24)).slice(0,24));
  return amount>0n?amount.toString():null;
}
export default function AgentPlayground({agentId,onSubmitted}:{agentId:string;onSubmitted?:()=>void}) {
 const [recipient,setRecipient]=useState(""); const [amount,setAmount]=useState("");
 const [agentToken,setAgentToken]=useState(""); const [payload,setPayload]=useState("");
 const [message,setMessage]=useState(""); const [result,setResult]=useState<Record<string,unknown>|null>(null); const [busy,setBusy]=useState(false);
 function build(){setMessage("");setResult(null);setPayload("");const amountYocto=parseNear(amount);if(!amountYocto){setMessage("Enter a positive NEAR amount with no more than 24 decimal places.");return;}const to=recipient.trim();if(to.length>64||!/^[a-z0-9]+([._-][a-z0-9]+)*$/.test(to)){setMessage("Enter a valid lowercase NEAR account ID (maximum 64 characters).");return;}setPayload(JSON.stringify({requestId:"encu-"+crypto.randomUUID(),to,amountYocto,expectedAgentId:agentId},null,2));}
 async function copyPayload(){if(!payload)return;try{await navigator.clipboard.writeText(payload);setMessage("JSON payload copied.");}catch{setMessage("Clipboard unavailable. Select and copy the JSON shown below.");}}
 async function submitRequest(){if(!payload||!agentToken.trim()||busy)return;const request=JSON.parse(payload) as {to:string;amountYocto:string};const amountNear=(Number(request.amountYocto)/Number(YOCTO)).toString();if(!window.confirm("Submit "+amountNear+" NEAR to "+request.to+" using agent "+agentId+"? If policy allows it, this can initiate a real NEAR testnet transfer."))return;setBusy(true);setMessage("");setResult(null);try{const response=await fetch("/api/agent/transfer",{method:"POST",headers:{authorization:"Bearer "+agentToken.trim(),"content-type":"application/json"},body:payload,cache:"no-store"});const body=await response.json().catch(()=>({error:"Invalid server response"}));setResult(body);setMessage(response.ok?"Request received by ENCU. Check its recorded status and finality below.":"Request returned HTTP "+response.status+". Review the response below.");if(response.ok)onSubmitted?.();}catch{setMessage("Could not reach ENCU. The outcome is unknown; check transaction activity before retrying.");}finally{setBusy(false);}}
 return <section className="developer-playground" aria-label="Request Payload Builder and Test Submission">
 <span className="developer-section-kicker">DEVELOPER TOOL</span><h4>Request payload builder</h4><p>Build the exact request body for this agent. Generation and copying do not submit a transfer.</p>
 <div className="developer-playground-fields"><label>Recipient NEAR account<input value={recipient} onChange={e=>setRecipient(e.target.value)} placeholder="recipient.near" autoCapitalize="none" autoCorrect="off"/></label><label>Amount (NEAR)<input value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.001" inputMode="decimal"/></label></div>
 <div className="developer-playground-controls"><button className="developer-button" type="button" onClick={build}>Generate payload</button>{payload&&<button className="developer-button secondary" type="button" onClick={()=>void copyPayload()}>Copy JSON</button>}</div>
 {payload&&<pre className="developer-playground-payload">{payload}</pre>}
 <div className="developer-playground-submit"><h4>Submit through ENCU</h4><p>Use this agent's bearer token, not your developer account password or session token. The token is kept in this page's component state and is not saved.</p><label>Agent bearer token<input type="password" value={agentToken} onChange={e=>setAgentToken(e.target.value)} placeholder="Paste the token issued when this agent was created" autoComplete="off"/></label><button className="developer-button" type="button" disabled={!payload||!agentToken.trim()||busy} onClick={()=>void submitRequest()}>{busy?"Submitting…":"Submit testnet request"}</button><p className="developer-playground-warning">Explicit submission can initiate a real testnet transfer if this agent is active and its configured allocation, limits, autonomous allowance and recipient permissions permit it. Do not retry an ambiguous response until you check activity.</p></div>
 {message&&<p className="developer-playground-warning" role="status">{message}</p>}{result&&<pre className="developer-playground-payload" aria-live="polite">{JSON.stringify(result,null,2)}</pre>}
 </section>;
}
