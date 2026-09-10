import { config } from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { paymentMiddleware } from '@x402/express';
import { decodePaymentResponseHeader } from '@x402/core/http';
import { createResourceServer } from './x402.js';
import { MODEL_CATALOGUE, type ModelTier } from '@x402-poc/shared';
import { logInferenceToHCS } from './hcs.js';
import { callProvider, getModelForTier, type ChatMessage } from './providers.js';
import { getBalance, addCredits, deductCredits } from './credits.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../../../.env') });

const PORT                      = parseInt(process.env.PORT ?? '4021');
const TESTNET_SERVICE_ACCOUNT   = process.env.HEDERA_SERVICE_ACCOUNT_ID ?? '';
const MAINNET_SERVICE_ACCOUNT   = process.env.HEDERA_SERVICE_MAINNET_ACCOUNT_ID ?? process.env.HEDERA_SERVICE_ACCOUNT_ID ?? '';

if (!TESTNET_SERVICE_ACCOUNT) {
  console.error('✗ HEDERA_SERVICE_ACCOUNT_ID is required in .env');
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
  console.error('✗ At least one of ANTHROPIC_API_KEY / OPENAI_API_KEY is required in .env');
  process.exit(1);
}

// $0.001 for both assets — USDC as Money string, HBAR as explicit AssetAmount (tinybars).
const USDC_PRICE = '$0.001';
const HBAR_PRICE = { asset: '0.0.0', amount: '100000' }; // 0.001 HBAR = 100,000 tinybars

// Legacy (non-tiered) chat-completions routes always resolve to the router's "default" tier model.
const LEGACY_TIER: ModelTier = 'default';

// Prepaid credit bundles — a small hardcoded catalogue, same spirit as the model router.
// Balance is tracked in USD; a purchase credits the buyer (the wallet that signed the x402
// payment) for the bundle's dollar amount.
const CREDIT_BUNDLES: Record<string, { price: string; amount: number }> = {
  starter: { price: '$1', amount: 1 },
  plus:    { price: '$5', amount: 5 },
};

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY ?? '';

const testnetRS = createResourceServer('testnet');
const mainnetRS = createResourceServer('mainnet');

const app = express();
app.use(cors({ exposedHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE', 'X-PAYMENT-RESPONSE'] }));
app.use(express.json({ limit: '10mb' }));

app.use(paymentMiddleware(
  {
    'POST /v1/testnet/usdc/chat/completions': {
      accepts: [{ scheme: 'exact', price: USDC_PRICE, network: 'hedera:testnet', payTo: TESTNET_SERVICE_ACCOUNT }],
      description: 'LLM inference — testnet USDC',
      mimeType: 'application/json',
    },
    'POST /v1/testnet/hbar/chat/completions': {
      accepts: [{ scheme: 'exact', price: HBAR_PRICE, network: 'hedera:testnet', payTo: TESTNET_SERVICE_ACCOUNT }],
      description: 'LLM inference — testnet HBAR',
      mimeType: 'application/json',
    },
  },
  testnetRS,
));

// Router-priced inference endpoints — the audit-logged /infer family described in the README.
// The client (agent) runs the router locally to pick a tier for its prompt, then calls the
// matching priced route below. x402 requires a static price per route, so tiers get one route
// each rather than a single dynamically-priced POST /infer.
app.use(paymentMiddleware(
  {
    'POST /infer/small-fast/chat/completions': {
      accepts: [{ scheme: 'exact', price: MODEL_CATALOGUE['small-fast'].price, network: 'hedera:testnet', payTo: TESTNET_SERVICE_ACCOUNT }],
      description: `LLM inference — ${MODEL_CATALOGUE['small-fast'].description}`,
      mimeType: 'application/json',
    },
    'POST /infer/default/chat/completions': {
      accepts: [{ scheme: 'exact', price: MODEL_CATALOGUE.default.price, network: 'hedera:testnet', payTo: TESTNET_SERVICE_ACCOUNT }],
      description: `LLM inference — ${MODEL_CATALOGUE.default.description}`,
      mimeType: 'application/json',
    },
    'POST /infer/large-capable/chat/completions': {
      accepts: [{ scheme: 'exact', price: MODEL_CATALOGUE['large-capable'].price, network: 'hedera:testnet', payTo: TESTNET_SERVICE_ACCOUNT }],
      description: `LLM inference — ${MODEL_CATALOGUE['large-capable'].description}`,
      mimeType: 'application/json',
    },
  },
  testnetRS,
));

// Credit bundle purchases — pay once from a connected wallet, spend down the balance across
// many chat messages afterward without signing again. See CREDIT_BUNDLES above.
app.use(paymentMiddleware(
  {
    'POST /credits/purchase/starter': {
      accepts: [{ scheme: 'exact', price: CREDIT_BUNDLES.starter.price, network: 'hedera:testnet', payTo: TESTNET_SERVICE_ACCOUNT }],
      description: `Prepaid credits — $${CREDIT_BUNDLES.starter.amount}`,
      mimeType: 'application/json',
    },
    'POST /credits/purchase/plus': {
      accepts: [{ scheme: 'exact', price: CREDIT_BUNDLES.plus.price, network: 'hedera:testnet', payTo: TESTNET_SERVICE_ACCOUNT }],
      description: `Prepaid credits — $${CREDIT_BUNDLES.plus.amount}`,
      mimeType: 'application/json',
    },
  },
  testnetRS,
));

app.use(paymentMiddleware(
  {
    'POST /v1/mainnet/usdc/chat/completions': {
      accepts: [{ scheme: 'exact', price: USDC_PRICE, network: 'hedera:mainnet', payTo: MAINNET_SERVICE_ACCOUNT }],
      description: 'LLM inference — mainnet USDC',
      mimeType: 'application/json',
    },
    'POST /v1/mainnet/hbar/chat/completions': {
      accepts: [{ scheme: 'exact', price: HBAR_PRICE, network: 'hedera:mainnet', payTo: MAINNET_SERVICE_ACCOUNT }],
      description: 'LLM inference — mainnet HBAR',
      mimeType: 'application/json',
    },
  },
  mainnetRS,
));

function decodeSettlement(res: Response): { transaction: string; payer: string | null } {
  const header = res.getHeader('PAYMENT-RESPONSE');
  if (typeof header !== 'string') return { transaction: 'unknown', payer: null };
  try {
    const settlement = decodePaymentResponseHeader(header);
    return { transaction: settlement.transaction ?? 'unknown', payer: settlement.payer ?? null };
  } catch {
    return { transaction: 'unknown', payer: null };
  }
}

async function handleInference(tier: ModelTier, req: Request, res: Response, logToHCS: boolean): Promise<void> {
  const { provider, model } = getModelForTier(tier);
  const messages = (req.body?.messages ?? []) as ChatMessage[];

  let completion;
  try {
    completion = await callProvider(provider, model, messages);
  } catch (err) {
    console.error(`Provider error (${provider}/${model}):`, err);
    res.status(502).json({ error: 'Upstream provider error', detail: String(err) });
    return;
  }

  if (logToHCS) {
    // The x402 middleware buffers this response and only attaches PAYMENT-RESPONSE — and only
    // actually flushes our 200 — after it settles the payment post-handler. A failed settlement
    // replaces the buffered response with a 402, so only log once we know it truly succeeded.
    res.once('finish', () => {
      if (res.statusCode !== 200) return;
      logInferenceToHCS({
        timestamp: new Date().toISOString(),
        model: `${provider}/${model}`,
        price: MODEL_CATALOGUE[tier].price,
        txReference: decodeSettlement(res).transaction,
      });
    });
  }

  res.json(completion);
}

for (const path of [
  '/v1/testnet/usdc/chat/completions',
  '/v1/testnet/hbar/chat/completions',
  '/v1/mainnet/usdc/chat/completions',
  '/v1/mainnet/hbar/chat/completions',
]) {
  app.post(path, (req, res) => handleInference(LEGACY_TIER, req, res, true));
}

for (const tier of Object.keys(MODEL_CATALOGUE) as ModelTier[]) {
  app.post(`/infer/${tier}/chat/completions`, (req, res) => handleInference(tier, req, res, true));
}

for (const [bundleId, bundle] of Object.entries(CREDIT_BUNDLES)) {
  app.post(`/credits/purchase/${bundleId}`, (req: Request, res: Response) => {
    res.once('finish', () => {
      if (res.statusCode !== 200) return;
      const { payer } = decodeSettlement(res);
      if (!payer) {
        console.error(`[credits] purchase settled but no payer in PAYMENT-RESPONSE (bundle ${bundleId})`);
        return;
      }
      addCredits(payer, bundle.amount).catch((err) => {
        console.error(`[credits] failed to credit ${payer} for bundle ${bundleId} (paid, but not credited — needs manual reconciliation):`, err);
      });
    });
    res.json({ bundle: bundleId, amount: bundle.amount });
  });
}

app.get('/credits/balance/:accountId', async (req: Request, res: Response) => {
  try {
    res.json({ accountId: req.params.accountId, balance: await getBalance(req.params.accountId) });
  } catch (err) {
    res.status(502).json({ error: 'Failed to read balance', detail: String(err) });
  }
});

// Internal-only: called by the agent server (not exposed to browsers) to draw down a user's
// prepaid balance before it pays for a message with its own wallet in "agent pays" mode.
// Demo-grade auth — a shared secret header, not a real API-key system.
app.post('/credits/deduct', async (req: Request, res: Response) => {
  if (!INTERNAL_API_KEY || req.header('x-internal-key') !== INTERNAL_API_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { accountId, amount } = req.body as { accountId?: string; amount?: number };
  if (!accountId || typeof amount !== 'number' || amount <= 0) {
    res.status(400).json({ error: 'accountId and positive amount required' });
    return;
  }
  try {
    const ok = await deductCredits(accountId, amount);
    if (!ok) {
      res.status(402).json({ error: 'Insufficient credits' });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'Failed to deduct credits', detail: String(err) });
  }
});

// Internal-only: refunds a deduction when the agent's own downstream payment/inference call
// fails after credits were already drawn down — same demo-grade shared-secret auth as /deduct.
app.post('/credits/refund', async (req: Request, res: Response) => {
  if (!INTERNAL_API_KEY || req.header('x-internal-key') !== INTERNAL_API_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { accountId, amount } = req.body as { accountId?: string; amount?: number };
  if (!accountId || typeof amount !== 'number' || amount <= 0) {
    res.status(400).json({ error: 'accountId and positive amount required' });
    return;
  }
  try {
    res.json({ ok: true, balance: await addCredits(accountId, amount) });
  } catch (err) {
    res.status(502).json({ error: 'Failed to refund credits', detail: String(err) });
  }
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    port: PORT,
    providers: {
      anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
      openai: Boolean(process.env.OPENAI_API_KEY),
    },
  });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Inference service running on http://localhost:${PORT}`);
  console.log(`   Testnet: /v1/testnet/{usdc,hbar}/chat/completions`);
  console.log(`   Mainnet: /v1/mainnet/{usdc,hbar}/chat/completions`);
  console.log(`   Price: $0.001 USDC or 0.001 HBAR per request`);
  console.log(`   Router-priced: /infer/{small-fast,default,large-capable}/chat/completions — see packages/shared/src/router.ts`);
  console.log(`   Providers: anthropic=${Boolean(process.env.ANTHROPIC_API_KEY)} openai=${Boolean(process.env.OPENAI_API_KEY)}\n`);
});
