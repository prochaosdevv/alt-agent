import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectModel, MODEL_CATALOGUE } from './router.js';

test('short prompt selects small-fast tier', () => {
  assert.equal(selectModel('hi there').tier, 'small-fast');
});

test('empty prompt selects small-fast tier', () => {
  assert.equal(selectModel('').tier, 'small-fast');
});

test('long prompt selects large-capable tier', () => {
  assert.equal(selectModel('a'.repeat(500)).tier, 'large-capable');
});

test('short prompt containing a keyword still selects large-capable', () => {
  assert.equal(selectModel('write a poem').tier, 'large-capable');
});

test('prompt with "code" keyword selects large-capable regardless of length', () => {
  assert.equal(selectModel('please write code for a binary search').tier, 'large-capable');
});

test('medium generic prompt selects default tier', () => {
  const prompt = 'What is the capital of France and why is it significant historically speaking today';
  assert.equal(selectModel(prompt).tier, 'default');
});

test('catalogue has three tiers with distinct prices', () => {
  const prices = new Set(Object.values(MODEL_CATALOGUE).map((entry) => entry.price));
  assert.equal(Object.keys(MODEL_CATALOGUE).length, 3);
  assert.equal(prices.size, 3);
});

test('selectModel always returns a catalogue entry', () => {
  const catalogueEntries = Object.values(MODEL_CATALOGUE);
  const result = selectModel('a normal length prompt about the weather today');
  assert.ok(catalogueEntries.includes(result));
});
