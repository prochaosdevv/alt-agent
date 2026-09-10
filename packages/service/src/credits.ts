import { getDb } from './db.js';

/**
 * Prepaid balance, tracked in USD (same unit as the router's tier prices), keyed by the
 * Hedera account id that purchased it. Purchased via a real x402 payment from that account
 * (see the /credits/purchase/* routes) and drawn down per chat message in "agent pays" mode.
 */
export interface CreditAccount {
  _id: string;
  balance: number;
}

const COLLECTION = 'credits';

export async function getBalance(accountId: string): Promise<number> {
  const db = await getDb();
  const doc = await db.collection<CreditAccount>(COLLECTION).findOne({ _id: accountId });
  return doc?.balance ?? 0;
}

export async function addCredits(accountId: string, amount: number): Promise<number> {
  const db = await getDb();
  const result = await db.collection<CreditAccount>(COLLECTION).findOneAndUpdate(
    { _id: accountId },
    { $inc: { balance: amount } },
    { upsert: true, returnDocument: 'after' },
  );
  return result?.balance ?? amount;
}

/** Atomically deducts `amount` only if the balance can cover it. Returns false if insufficient. */
export async function deductCredits(accountId: string, amount: number): Promise<boolean> {
  const db = await getDb();
  const result = await db.collection<CreditAccount>(COLLECTION).findOneAndUpdate(
    { _id: accountId, balance: { $gte: amount } },
    { $inc: { balance: -amount } },
  );
  return result !== null;
}
