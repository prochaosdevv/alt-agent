import { Client, PrivateKey, TopicMessageSubmitTransaction } from '@hiero-ledger/sdk';

export interface InferenceLogEntry {
  timestamp: string;
  model: string;
  price: string;
  txReference: string;
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
 * Fire-and-forget: submits one message to the configured HCS topic after a successful
 * paid inference. Never throws — logging failures must not affect the inference response
 * already sent to the caller.
 */
export function logInferenceToHCS(entry: InferenceLogEntry): void {
  const topicId = process.env.HCS_TOPIC_ID;
  if (!topicId) {
    console.warn('[hcs] HCS_TOPIC_ID not set — skipping audit log');
    return;
  }

  const client = getClient();
  if (!client) {
    console.warn('[hcs] HEDERA_SERVICE_ACCOUNT_ID / HEDERA_SERVICE_PRIVATE_KEY not set — skipping audit log');
    return;
  }

  new TopicMessageSubmitTransaction()
    .setTopicId(topicId)
    .setMessage(JSON.stringify(entry))
    .execute(client)
    .then((tx) => tx.getReceipt(client))
    .then((receipt) => {
      console.log(`[hcs] logged inference — topic ${topicId}, status ${receipt.status.toString()}`);
    })
    .catch((err) => {
      console.error('[hcs] failed to log inference (non-fatal):', err instanceof Error ? err.message : err);
    });
}
