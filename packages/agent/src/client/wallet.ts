import { AccountId, TransferTransaction, TransactionId, Hbar, TokenId, LedgerId } from '@hiero-ledger/sdk';
import { DAppConnector, HederaSessionEvent, HederaJsonRpcMethod } from '@hashgraph/hedera-wallet-connect';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactHederaScheme } from '@x402/hedera/exact/client';
import type { PaymentRequirements } from '@x402/core/types';
import type { DAppSigner } from '@hashgraph/hedera-wallet-connect';
import { selectModel, MODEL_CATALOGUE } from '@x402-poc/shared';

/**
 * Builds the x402 Hedera "exact" scheme's ClientHederaSigner shape (accountId +
 * createPartiallySignedTransferTransaction) backed by a WalletConnect-connected wallet's
 * DAppSigner, instead of a raw PrivateKey. Mirrors @x402/hedera's createClientHederaSigner
 * transaction-building logic exactly — only the freeze+sign step differs (signer, not key).
 */
function createWalletConnectHederaSigner(accountId: string, dAppSigner: DAppSigner) {
  return {
    accountId,
    async createPartiallySignedTransferTransaction(requirements: PaymentRequirements): Promise<string> {
      const feePayer = requirements.extra?.feePayer;
      if (typeof feePayer !== 'string') {
        throw new Error('feePayer is required in paymentRequirements.extra');
      }
      const amount = BigInt(requirements.amount);
      if (amount <= 0n) throw new Error('amount must be greater than zero');

      const payer = AccountId.fromString(accountId);
      const payTo = AccountId.fromString(requirements.payTo);
      const tx = new TransferTransaction();

      if (requirements.asset === '0.0.0') {
        tx.addHbarTransfer(payer, Hbar.fromTinybars((-amount).toString()));
        tx.addHbarTransfer(payTo, Hbar.fromTinybars(amount.toString()));
      } else {
        const tokenId = TokenId.fromString(requirements.asset);
        tx.addTokenTransfer(tokenId, payer, -amount);
        tx.addTokenTransfer(tokenId, payTo, amount);
      }

      // x402's Hedera "exact" scheme requires the transaction id's payer to be the
      // facilitator's fee payer, not the signer. DAppSigner.signTransaction() would
      // overwrite that (via its own freezeWithSigner -> populateTransaction, which sets
      // the id to the *connected* account) if the transaction isn't already frozen — and
      // since setTransactionId() locks that field on first call, a second call throws
      // "list is locked". So freeze it ourselves first (with node account ids set, which
      // freeze() requires) — signTransaction() then sees it's already frozen and skips
      // straight to signing, leaving our fee-payer transaction id intact.
      tx.setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)));
      tx.setNodeAccountIds([AccountId.fromString('0.0.3')]);
      tx.freeze();
      const signed = await dAppSigner.signTransaction(tx);
      return btoa(String.fromCharCode(...signed.toBytes()));
    },
  };
}

let connector: DAppConnector | null = null;
let connectedAccountId: string | null = null;

async function init(projectId: string): Promise<void> {
  if (connector) return;

  connector = new DAppConnector(
    {
      name: 'Alt-agent',
      description: 'Pay-per-inference AI agent on Hedera, gated by x402',
      url: window.location.origin,
      icons: [`${window.location.origin}/favicon.ico`],
    },
    LedgerId.TESTNET,
    projectId,
    Object.values(HederaJsonRpcMethod),
    [HederaSessionEvent.ChainChanged, HederaSessionEvent.AccountsChanged],
  );

  await connector.init({ logger: 'error' });

  // WalletConnect persists sessions itself (browser storage) — init() already restored any
  // existing one into connector.signers. Pick it up so a page reload doesn't force a reconnect.
  if (connector.signers.length > 0) {
    connectedAccountId = connector.signers[connector.signers.length - 1].getAccountId().toString();
  }
}

async function connect(): Promise<{ accountId: string }> {
  if (!connector) throw new Error('Wallet connector not initialised — call init() first');

  const session = await connector.openModal();
  const accountIdStr = session.namespaces?.hedera?.accounts?.[0]?.split(':').pop();
  if (!accountIdStr) throw new Error('No Hedera account returned by wallet');

  connectedAccountId = accountIdStr;
  return { accountId: accountIdStr };
}

async function disconnect(): Promise<void> {
  if (!connector) return;
  try {
    await connector.disconnectAll();
  } catch {
    // No active session — fine to ignore.
  }
  connectedAccountId = null;
}

function getAccountId(): string | null {
  return connectedAccountId;
}

function getWalletPayFetch(): typeof fetch {
  if (!connector || !connectedAccountId) throw new Error('Wallet not connected');

  const dAppSigner = connector.getSigner(AccountId.fromString(connectedAccountId));
  const signer = createWalletConnectHederaSigner(connectedAccountId, dAppSigner);
  const client = new x402Client().register('hedera:testnet', new ExactHederaScheme(signer));
  return wrapFetchWithPayment(fetch, client);
}

/** Pays for a credit bundle from the connected wallet via x402, direct to the inference service. */
async function purchaseCredits(serviceBaseUrl: string, bundleId: string): Promise<{ bundle: string; amount: number }> {
  const payFetch = getWalletPayFetch();

  const res = await payFetch(`${serviceBaseUrl}/credits/purchase/${bundleId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Purchase failed (HTTP ${res.status}): ${JSON.stringify(body)}`);
  }

  return res.json();
}

/**
 * Pays for a single inference call directly from the connected wallet via x402 — used whenever
 * the agent-pays-from-credits path doesn't apply (credits insufficient, or a network/asset combo
 * the credits system doesn't cover, like HBAR or mainnet). Prompts a wallet signature for this
 * one message (unlike the credits path, which the agent pays autonomously with no popup).
 *
 * `route` is either a tier ('small-fast' | 'default' | 'large-capable' -> /infer/{tier}/...) or
 * a legacy { network, asset } pair (-> /v1/{network}/{asset}/...).
 */
async function payPerMessage(
  serviceBaseUrl: string,
  route: { tier: string } | { network: string; asset: string },
  messages: { role: string; content: string }[],
): Promise<string> {
  const payFetch = getWalletPayFetch();

  const path = 'tier' in route
    ? `/infer/${route.tier}/chat/completions`
    : `/v1/${route.network}/${route.asset.toLowerCase()}/chat/completions`;

  const res = await payFetch(`${serviceBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Payment failed (HTTP ${res.status}): ${JSON.stringify(body)}`);
  }

  const completion = await res.json();
  return completion.choices?.[0]?.message?.content ?? '';
}

async function getBalance(serviceBaseUrl: string, accountId: string): Promise<number> {
  const res = await fetch(`${serviceBaseUrl}/credits/balance/${accountId}`);
  if (!res.ok) throw new Error(`Failed to fetch balance (HTTP ${res.status})`);
  const data = await res.json();
  return data.balance ?? 0;
}

(window as unknown as { X402Wallet: unknown }).X402Wallet = {
  init,
  connect,
  disconnect,
  getAccountId,
  purchaseCredits,
  payPerMessage,
  getBalance,
  selectModel,
  MODEL_CATALOGUE,
};
