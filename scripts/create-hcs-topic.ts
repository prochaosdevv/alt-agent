/**
 * One-time setup: creates the Hedera Consensus Service topic used for the
 * inference audit trail, and prints the topic ID to add to .env as HCS_TOPIC_ID.
 *
 * Usage (run from repo root):
 *   npm run create-topic -w scripts
 *
 * Uses HEDERA_SERVICE_ACCOUNT_ID / HEDERA_SERVICE_PRIVATE_KEY from .env as the topic operator.
 */
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Client, PrivateKey, TopicCreateTransaction } from '@hiero-ledger/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env') });

const accountIdStr   = process.env.HEDERA_SERVICE_ACCOUNT_ID;
const privateKeyStr  = process.env.HEDERA_SERVICE_PRIVATE_KEY;

if (!accountIdStr || !privateKeyStr) {
  console.error('Required environment variables (set in .env):');
  console.error('  HEDERA_SERVICE_ACCOUNT_ID=0.0.XXXXX');
  console.error('  HEDERA_SERVICE_PRIVATE_KEY=0x...');
  process.exit(1);
}

async function createTopic(): Promise<void> {
  const client = Client.forTestnet().setOperator(accountIdStr!, PrivateKey.fromStringECDSA(privateKeyStr!));

  console.log('\nCreating HCS topic for the inference audit trail...');

  const tx = await new TopicCreateTransaction()
    .setTopicMemo('x402 inference pay-per-request audit trail')
    .execute(client);

  const receipt = await tx.getReceipt(client);
  const topicId = receipt.topicId?.toString();

  console.log(`✓ Topic created: ${topicId}`);
  console.log(`\n  Add this to your .env:\n  HCS_TOPIC_ID=${topicId}\n`);
  console.log(`  View it on HashScan: https://hashscan.io/testnet/topic/${topicId}\n`);

  client.close();
}

createTopic().catch((err) => {
  console.error('✗ Topic creation failed:', err.message ?? err);
  process.exit(1);
});
