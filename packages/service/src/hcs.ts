import { Client, PrivateKey, TopicMessageSubmitTransaction } from '@hiero-ledger/sdk';

export interface InferenceLogEntry {
  timestamp: string;
  model: string;
  price: string;
}

export interface HCSReceipt {
  topicId: string;
  transactionId: string;
}

let _client: Client | null = null;

function getClient(): Client | null {
  if (_client) return _client;

  const accountId = process.env.HEDERA_SERVICE_ACCOUNT_ID;
  const privateKeyStr = process.env.HEDERA_SERVICE_PRIVATE_KEY;
  if (!accountId || !privateKeyStr) return null;

  _client = Client.forTestnet().setOperator(accountId, PrivateKey.fromStringECDSA(privateKeyStr));
  return _client;
}

/**
 * Submits one message to the configured HCS topic for a paid inference, and resolves with
 * the transaction ID as soon as the network accepts the submission — without waiting for the
 * full consensus receipt, so the caller (which is holding up its own HTTP response for this)
 * doesn't pay for that extra round-trip too. Consensus is confirmed separately afterward,
 * fire-and-forget, purely for the server log. Never throws — a failed audit log must not fail
 * the inference response.
 */
export async function logInferenceToHCS(entry: InferenceLogEntry): Promise<HCSReceipt | null> {
  const topicId = process.env.HCS_TOPIC_ID;
  if (!topicId) {
    console.warn('[hcs] HCS_TOPIC_ID not set — skipping audit log');
    return null;
  }

  const client = getClient();
  if (!client) {
    console.warn('[hcs] HEDERA_SERVICE_ACCOUNT_ID / HEDERA_SERVICE_PRIVATE_KEY not set — skipping audit log');
    return null;
  }

  try {
    const tx = await new TopicMessageSubmitTransaction()
      .setTopicId(topicId)
      .setMessage(JSON.stringify(entry))
      .execute(client);

    const transactionId = tx.transactionId.toString();

    tx.getReceipt(client)
      .then((receipt) => {
        console.log(`[hcs] confirmed — topic ${topicId}, tx ${transactionId}, status ${receipt.status.toString()}`);
      })
      .catch((err) => {
        console.error('[hcs] consensus confirmation failed (non-fatal):', err instanceof Error ? err.message : err);
      });

    return { topicId, transactionId };
  } catch (err) {
    console.error('[hcs] failed to submit inference log (non-fatal):', err instanceof Error ? err.message : err);
    return null;
  }
}
