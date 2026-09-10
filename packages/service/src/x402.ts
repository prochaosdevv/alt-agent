import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { ExactHederaScheme } from '@x402/hedera/exact/server';

export function createResourceServer(network: 'testnet' | 'mainnet') {
  const envKey = network === 'mainnet' ? 'X402_MAINNET_FACILITATOR_URL' : 'X402_TESTNET_FACILITATOR_URL';
  const defaultUrl = network === 'mainnet'
    ? 'https://api.blocky402.com'
    : 'https://x402.org/facilitator';
  const facilitatorUrl = process.env[envKey] ?? defaultUrl;

  const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

  return new x402ResourceServer(facilitatorClient).register(
    'hedera:*',
    new ExactHederaScheme({}),
  );
}