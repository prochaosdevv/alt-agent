import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import { createClientHederaSigner } from '@x402/hedera';
import { PrivateKey } from '@hiero-ledger/sdk';

export type PaymentStage =
  | 'connecting'       // initial request sent
  | 'payment_required' // 402 received, signing Hedera tx
  | 'sending'          // signed tx submitted to facilitator
  | 'model_running'    // timed: emitted ~2s into the payment retry
  | 'accepted';        // 200 back — payment settled, response ready

// Initialise once at startup. Creates signers for both networks so the UI
// can switch without restarting the server.
export function initX402() {
  const testnetAccountId    = process.env.HEDERA_AGENT_ACCOUNT_ID;
  const testnetPrivateKeyStr = process.env.HEDERA_AGENT_PRIVATE_KEY;
  const mainnetAccountId    = process.env.HEDERA_AGENT_MAINNET_ACCOUNT_ID ?? process.env.HEDERA_AGENT_ACCOUNT_ID;
  const mainnetPrivateKeyStr = process.env.HEDERA_AGENT_MAINNET_PRIVATE_KEY ?? process.env.HEDERA_AGENT_PRIVATE_KEY;

  if (!testnetAccountId || !testnetPrivateKeyStr) {
    throw new Error('HEDERA_AGENT_ACCOUNT_ID and HEDERA_AGENT_PRIVATE_KEY must be set in .env');
  }
  if (!mainnetAccountId || !mainnetPrivateKeyStr) {
    throw new Error('Mainnet agent credentials not found in .env');
  }

  const testnetSigner = createClientHederaSigner(
    testnetAccountId,
    PrivateKey.fromStringECDSA(testnetPrivateKeyStr),
    { network: 'hedera:testnet' },
  );

  const mainnetSigner = createClientHederaSigner(
    mainnetAccountId,
    PrivateKey.fromStringECDSA(mainnetPrivateKeyStr),
    { network: 'hedera:mainnet' },
  );

  const sharedClient = new x402Client()
    .register('hedera:testnet', new ExactHederaScheme(testnetSigner))
    .register('hedera:mainnet', new ExactHederaScheme(mainnetSigner));

  function createFetchForRequest(onStatus: (stage: PaymentStage) => void): typeof fetch {
    let modelRunningTimer: ReturnType<typeof setTimeout> | null = null;

    const statusFetch: typeof fetch = async (input) => {
      const req = input instanceof Request ? input : new Request(String(input));
      const isPaymentRetry = req.headers.has('PAYMENT-SIGNATURE') || req.headers.has('X-PAYMENT');

      if (!isPaymentRetry) {
        onStatus('connecting');
        const res = await globalThis.fetch(input);
        if (res.status === 402) {
          onStatus('payment_required');
        }
        return res;
      } else {
        onStatus('sending');

        modelRunningTimer = setTimeout(() => {
          onStatus('model_running');
          modelRunningTimer = null;
        }, 2000);

        const res = await globalThis.fetch(input);

        if (modelRunningTimer) {
          clearTimeout(modelRunningTimer);
          modelRunningTimer = null;
        }

        if (res.ok) {
          onStatus('accepted');
        }
        return res;
      }
    };

    return wrapFetchWithPayment(statusFetch, sharedClient);
  }

  return { createFetchForRequest };
}