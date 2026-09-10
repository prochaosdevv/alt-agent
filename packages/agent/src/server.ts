import { config } from 'dotenv';
import { dirname, resolve, join } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';
import { generateText } from 'ai';
import { initX402, type PaymentStage } from './x402-client.js';
import { buildModelForRequest, buildModelForTier } from './model.js';
import { selectModel, MODEL_CATALOGUE, type ModelTier } from '@x402-poc/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

const PORT             = parseInt(process.env.AGENT_PORT ?? '3001');
const COST_PER_REQUEST = 0.001;

const TESTNET_AGENT_ACCOUNT   = process.env.HEDERA_AGENT_ACCOUNT_ID ?? '';
const MAINNET_AGENT_ACCOUNT   = process.env.HEDERA_AGENT_MAINNET_ACCOUNT_ID ?? process.env.HEDERA_AGENT_ACCOUNT_ID ?? '';
const TESTNET_SERVICE_ACCOUNT = process.env.HEDERA_SERVICE_ACCOUNT_ID ?? '';
const MAINNET_SERVICE_ACCOUNT = process.env.HEDERA_SERVICE_MAINNET_ACCOUNT_ID ?? process.env.HEDERA_SERVICE_ACCOUNT_ID ?? '';

// INFERENCE_SERVICE_URL is used server-side (this process calling the service directly — fine
// as an internal Docker network hostname like http://service:4021). PUBLIC_SERVICE_URL is what
// gets handed to the browser for its own direct wallet-connect calls, which need a hostname the
// browser can actually reach — defaults to the same value for plain local dev (both localhost).
const INFERENCE_SERVICE_URL   = (process.env.INFERENCE_SERVICE_URL ?? 'http://localhost:4021').replace(/\/v1\/?$/, '');
const PUBLIC_SERVICE_URL      = (process.env.PUBLIC_SERVICE_URL ?? INFERENCE_SERVICE_URL).replace(/\/v1\/?$/, '');
const INTERNAL_API_KEY        = process.env.INTERNAL_API_KEY ?? '';
const WALLETCONNECT_PROJECT_ID = process.env.WALLETCONNECT_PROJECT_ID ?? '';

/** Draws down a connected wallet's prepaid credit balance via the service's internal endpoint. */
async function deductCredits(accountId: string, amount: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${INFERENCE_SERVICE_URL}/credits/deduct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_API_KEY },
      body: JSON.stringify({ accountId, amount }),
    });
    if (res.status === 402) return { ok: false, error: 'Insufficient credits — buy more to keep chatting.' };
    if (!res.ok) return { ok: false, error: `Credit deduction failed (HTTP ${res.status})` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Credit deduction failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const x402 = initX402();

let totalSpent = 0;

const STAGE_LABELS: Record<PaymentStage, string> = {
  connecting:       'Connecting to inference service…',
  payment_required: 'Payment required — signing Hedera transaction…',
  sending:          'Submitting payment to x402 facilitator…',
  model_running:    'Payment submitted — awaiting model response…',
  accepted:         'Payment settled ✓',
};

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

type ChatMessage = { role: 'user' | 'assistant'; content: string };
type Network     = 'testnet' | 'mainnet';

const TIER_VALUES = new Set<string>(Object.keys(MODEL_CATALOGUE));

function sendSSE(res: express.Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

app.post('/api/chat', async (req, res) => {
  const {
    messages,
    network = 'testnet',
    asset   = 'USDC',
    tier    = 'auto',
    payerAccountId,
  } = req.body as { messages: ChatMessage[]; network?: Network; asset?: string; tier?: string; payerAccountId?: string };

  const safeNetwork: Network = network === 'mainnet' ? 'mainnet' : 'testnet';
  const safeAsset            = asset.toUpperCase() === 'HBAR' ? 'HBAR' : 'USDC';

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'messages array required' });
    return;
  }

  // Router-priced /infer routes are USDC-only, but that's the agent's own wallet paying — the
  // caller's asset choice (USDC/HBAR) doesn't matter for a credits-covered message. Only
  // mainnet stays outside credits/tiering entirely.
  const tieringAvailable = safeNetwork === 'testnet';
  let resolvedTier: ModelTier | null = null;
  let cost = COST_PER_REQUEST;

  if (tieringAvailable) {
    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    resolvedTier = TIER_VALUES.has(tier) ? (tier as ModelTier) : selectModel(lastUserMessage).tier;
    cost = parseFloat(MODEL_CATALOGUE[resolvedTier].price.replace('$', ''));

    // Agent pays with its own wallet, but only on behalf of a connected wallet with prepaid
    // credits — buy a bundle with "Connect Wallet" first.
    if (!payerAccountId) {
      res.status(402).json({ error: 'Connect a wallet and buy credits before chatting.' });
      return;
    }
    const deduction = await deductCredits(payerAccountId, cost);
    if (!deduction.ok) {
      res.status(402).json({ error: deduction.error });
      return;
    }
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const fetchForRequest = x402.createFetchForRequest((stage: PaymentStage) => {
    sendSSE(res, 'status', { stage, message: STAGE_LABELS[stage] });
  });

  try {
    const model = resolvedTier
      ? buildModelForTier(fetchForRequest, resolvedTier)
      : buildModelForRequest(fetchForRequest, safeNetwork, safeAsset);
    const result = await generateText({ model, messages });

    totalSpent = parseFloat((totalSpent + cost).toFixed(6));

    const agentAccountId   = safeNetwork === 'mainnet' ? MAINNET_AGENT_ACCOUNT   : TESTNET_AGENT_ACCOUNT;
    const serviceAccountId = safeNetwork === 'mainnet' ? MAINNET_SERVICE_ACCOUNT : TESTNET_SERVICE_ACCOUNT;

    console.log(`[chat] ${safeNetwork} ${safeAsset}${resolvedTier ? ` tier:${resolvedTier}` : ''} | cost: ${cost} | total: ${totalSpent} | reply: ${result.text.slice(0, 60)}…`);

    sendSSE(res, 'done', {
      reply: result.text,
      cost,
      totalSpent,
      network: safeNetwork,
      asset: safeAsset,
      tier: resolvedTier,
      agentAccountId,
      serviceAccountId,
    });
  } catch (err) {
    console.error('[chat] Error:', err);
    if (resolvedTier && payerAccountId) {
      // Credits were drawn down before this call — give them back since it never completed.
      await fetch(`${INFERENCE_SERVICE_URL}/credits/refund`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-key': INTERNAL_API_KEY },
        body: JSON.stringify({ accountId: payerAccountId, amount: cost }),
      }).catch((refundErr) => console.error('[chat] refund failed:', refundErr));
    }
    sendSSE(res, 'error', { error: err instanceof Error ? err.message : String(err) });
  }

  res.end();
});

app.get('/api/config', (_req, res) => {
  res.json({
    walletConnectProjectId: WALLETCONNECT_PROJECT_ID,
    serviceBaseUrl: PUBLIC_SERVICE_URL,
  });
});

app.get('/api/stats', (_req, res) => {
  res.json({
    totalSpent,
    costPerRequest: COST_PER_REQUEST,
    agentAccountId: TESTNET_AGENT_ACCOUNT,
    serviceAccountId: TESTNET_SERVICE_ACCOUNT,
  });
});

app.listen(PORT, () => {
  console.log(`\n🤖 Agent UI server running on http://localhost:${PORT}`);
  console.log(`   Open that URL in your browser to start chatting\n`);
});