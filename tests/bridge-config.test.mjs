import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConfig, pairConfig, planPairs } from '../scripts/bridge-config.mjs';
const registry = () => ({
  controllerRepo: 'B/controller', bot: 'transport[bot]', sourceBot: 'sync[bot]',
  pairs: Array.from({ length: 7 }, (_, i) => ({ id: `pair-${i + 1}`, source: `A/repo-${i + 1}`, target: `B/repo-${i + 1}` })),
});
const event = repo => ({
  TRIGGER_SOURCE_REPO: repo, TRIGGER_SOURCE_SHA: 'a'.repeat(40), TRIGGER_SOURCE_RUN_ID: '123',
  TRIGGER_SOURCE_EVENT: 'pull_request_target', TRIGGER_SOURCE_PR: '1',
});
test('seven pairs reuse one engine; an A or B event selects exactly its pair', () => {
  for (const p of registry().pairs) {
    for (const repo of [p.source, p.target]) {
      const result = planPairs(registry(), event(repo));
      assert.equal(result.include.length, 1);
      assert.equal(result.include[0].id, p.id);
      assert.equal(result.include[0].targetRepo, p.target.split('/')[1]);
    }
  }
});
test('schedule/manual without event reconciles every configured pair', () => {
  assert.deepEqual(planPairs(registry()).include.map(x => x.id), registry().pairs.map(x => x.id));
});
test('unknown repository and incomplete/spoofed trigger fail before token creation', () => {
  assert.throws(() => planPairs(registry(), event('A/unknown')));
  assert.throws(() => planPairs(registry(), { TRIGGER_SOURCE_PR: '1' }));
  assert.throws(() => planPairs(registry(), { ...event('A/repo-1'), TRIGGER_SOURCE_EVENT: 'push', TRIGGER_SOURCE_PR: '' }));
  assert.throws(() => planPairs(registry(), { ...event('B/repo-1'), TRIGGER_SOURCE_SHA: 'invalid' }));
});
test('repository ownership is unambiguous, including casing and controller overlap', () => {
  for (const [key, value] of [['source', 'a/REPO-1'], ['target', 'A/repo-1'], ['source', 'B/controller'], ['id', 'pair-1']]) {
    const r = registry(); r.pairs[1][key] = value;
    assert.throws(() => validateConfig(r));
  }
});
test('pair config passes only its endpoints and the shared three-app setup', () => {
  assert.deepEqual(pairConfig(registry(), 'pair-7'), {
    source: 'A/repo-7', target: 'B/repo-7', sourceBranch: 'main', targetBranch: 'main', controllerRepo: 'B/controller', bot: 'transport[bot]', sourceBot: 'sync[bot]',
  });
  assert.throws(() => pairConfig(registry(), 'unregistered'));
});
test('invalid registry identifiers cannot become matrix or shell inputs', () => {
  for (const p of [null, { id: 'x\ninject', source: 'A/r', target: 'B/r' }, { id: 'x', source: 'A/r;echo', target: 'B/r' }]) {
    const r = registry(); r.pairs[0] = p; assert.throws(() => validateConfig(r));
  }
  assert.throws(() => validateConfig({ ...registry(), pairs: [] }));
});
