/**
 * End-to-end smoke test for the router-priced /infer endpoint:
 *   router picks a tier for the prompt -> x402-paid POST to that tier's route
 *   -> real Claude/GPT response -> (service-side) HCS audit log.
 *
 * Usage (run from repo root, after `npm run service` is up):
 *   npm run smoke-test -w scripts -- "your prompt here"
 */
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PrivateKey } from '@hiero-ledger/sdk';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { createClientHederaSigner } from '@x402/hedera';
import { selectModel } from '@x402-poc/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env') });

const accountId  = process.env.HEDERA_AGENT_ACCOUNT_ID;
const privateKey = process.env.HEDERA_AGENT_PRIVATE_KEY;
const serviceUrl = process.env.INFERENCE_SERVICE_URL ?? 'http://localhost:4021';

if (!accountId || !privateKey) {
  console.error('Required in .env: HEDERA_AGENT_ACCOUNT_ID, HEDERA_AGENT_PRIVATE_KEY');
  process.exit(1);
}

const prompt = process.argv.slice(2).join(' ') || 'Say hello in one short sentence.';
const { tier, price } = selectModel(prompt);

console.log(`Prompt: "${prompt}"`);
console.log(`Router selected tier: ${tier} (${price})`);

const signer = createClientHederaSigner(
  accountId,
  PrivateKey.fromStringECDSA(privateKey),
  { network: 'hedera:testnet' },
);

const client = new x402Client().register('hedera:testnet', new ExactHederaScheme(signer));
const payFetch = wrapFetchWithPayment(fetch, client);

async function run(): Promise<void> {
  const res = await payFetch(`${serviceUrl}/infer/${tier}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
  });

  console.log(`\nHTTP ${res.status}`);
  console.log(await res.json());
}

run().catch((err) => {
  console.error('✗ Smoke test failed:', err.message ?? err);
  process.exit(1);
});
