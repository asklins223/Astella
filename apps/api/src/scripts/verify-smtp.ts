import { verifyOutboundEmail } from "../lib/outbound-email.ts";

const providers = await verifyOutboundEmail();
const ok = providers.some(provider => provider.status === "verified");
console.log(JSON.stringify({ ok, scope: "smtp-tls-and-authentication", providers }));
if (!ok) process.exitCode = 1;
