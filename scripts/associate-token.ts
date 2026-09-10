/**
 * Associate the USDC HTS token with a Hedera account on testnet or mainnet.
 * Not needed for HBAR payments — HBAR is native and requires no association.
 *
 * Usage (run from repo root):
 *   HEDERA_ACCOUNT_ID=0.0.XXXXX HEDERA_PRIVATE_KEY=0x... npm run associate -w scripts
 *   HEDERA_ACCOUNT_ID=0.0.XXXXX HEDERA_PRIVATE_KEY=0x... HEDERA_NETWORK=mainnet npm run associate -w scripts
 *
 * Or set the values in .env and run without inline env vars.
 */
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  Client,
  PrivateKey,
  TokenAssociateTransaction,
  TokenId,
  AccountId,
} from '@hiero-ledger/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '../.env') });

const network       = (process.env.HEDERA_NETWORK ?? 'testnet') as 'testnet' | 'mainnet';
const accountIdStr  = process.env.HEDERA_ACCOUNT_ID ?? process.env.HEDERA_AGENT_ACCOUNT_ID;
const privateKeyStr = process.env.HEDERA_PRIVATE_KEY ?? process.env.HEDERA_AGENT_PRIVATE_KEY;

const USDC_TOKEN_IDS = {
  testnet: '0.0.429274',
  mainnet: '0.0.456858',
};
const USDC_TOKEN_ID = USDC_TOKEN_IDS[network];

if (!accountIdStr || !privateKeyStr) {
  console.error('Required environment variables:');
  console.error('  HEDERA_ACCOUNT_ID=0.0.XXXXX');
  console.error('  HEDERA_PRIVATE_KEY=0x...');
  console.error('\nOr set HEDERA_AGENT_ACCOUNT_ID / HEDERA_AGENT_PRIVATE_KEY in .env');
  console.error('\nOptionally set HEDERA_NETWORK=mainnet (default: testnet)');
  process.exit(1);
}

async function associateToken(): Promise<void> {
  const accountId  = AccountId.fromString(accountIdStr!);
  const privateKey = PrivateKey.fromStringECDSA(privateKeyStr!);
  const client     = (network === 'mainnet' ? Client.forMainnet() : Client.forTestnet())
    .setOperator(accountId, privateKey);

  console.log(`\nAssociating USDC (${USDC_TOKEN_ID}) with account ${accountIdStr} on Hedera ${network}...`);

  const tx = await new TokenAssociateTransaction()
    .setAccountId(accountId)
    .setTokenIds([TokenId.fromString(USDC_TOKEN_ID)])
    .execute(client);

  const receipt = await tx.getReceipt(client);

  console.log(`✓ Token association successful!`);
  console.log(`  Transaction ID : ${tx.transactionId?.toString()}`);
  console.log(`  Status         : ${receipt.status.toString()}`);

  if (network === 'mainnet') {
    console.log(`\n  Account ${accountIdStr} can now send and receive USDC (${USDC_TOKEN_ID}) on mainnet.`);
    console.log(`  Fund with USDC at: https://faucet.circle.com (select Hedera Mainnet)\n`);
  } else {
    console.log(`\n  Account ${accountIdStr} can now send and receive USDC (${USDC_TOKEN_ID}) on testnet.`);
    console.log(`  Request testnet USDC at: https://faucet.circle.com (select Hedera Testnet)\n`);
  }

  client.close();
}

associateToken().catch((err) => {
  console.error('✗ Association failed:', err.message ?? err);
  process.exit(1);
});
