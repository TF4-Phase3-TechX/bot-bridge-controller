import { readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notificationMetadata } from './pr-bridge-policy.mjs';

export function validateConfig(value) {
  const repo = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/;
  if (!value || !repo.test(value.controllerRepo ?? '')
    || !/^[A-Za-z0-9_-]+\[bot\]$/.test(value.bot ?? '')
    || !/^[A-Za-z0-9_-]+\[bot\]$/.test(value.sourceBot ?? '')
    || !Array.isArray(value.pairs) || !value.pairs.length || value.pairs.length > 256) {
    throw new Error('Invalid bridge registry');
  }
  const ids = new Set(), repos = new Set([value.controllerRepo.toLowerCase()]);
  for (const pair of value.pairs) {
    if (!pair || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(pair.id ?? '') || ids.has(pair.id)
      || !repo.test(pair.source ?? '') || !repo.test(pair.target ?? '')) throw new Error('Invalid or duplicate pair');
    ids.add(pair.id);
    for (const name of [pair.source, pair.target]) {
      if (repos.has(name.toLowerCase())) throw new Error('A repository may belong to only one pair; controller must remain separate');
      repos.add(name.toLowerCase());
    }
  }
  return value;
}

export function loadConfig() {
  return validateConfig(JSON.parse(readFileSync(new URL('../bridge.config.json', import.meta.url), 'utf8')));
}

export function pairConfig(registry, id) {
  validateConfig(registry);
  const pair = registry.pairs.find(p => p.id === id);
  if (!pair) throw new Error('Unknown bridge pair');
  return { source: pair.source, target: pair.target, controllerRepo: registry.controllerRepo, bot: registry.bot, sourceBot: registry.sourceBot };
}

export function planPairs(registry, env = {}) {
  validateConfig(registry);
  const hasEvent = ['REPO', 'SHA', 'RUN_ID', 'EVENT', 'PR'].some(k => Boolean(env[`TRIGGER_SOURCE_${k}`]));
  const pairs = hasEvent
    ? registry.pairs.filter(p => [p.source, p.target].includes(env.TRIGGER_SOURCE_REPO))
    : registry.pairs;
  if (!pairs.length) throw new Error('Notification repository is not registered');
  return { include: pairs.map(p => {
    notificationMetadata({
      source: p.source, target: p.target, repo: env.TRIGGER_SOURCE_REPO, sha: env.TRIGGER_SOURCE_SHA,
      runId: env.TRIGGER_SOURCE_RUN_ID, event: env.TRIGGER_SOURCE_EVENT, pr: env.TRIGGER_SOURCE_PR,
    });
    const [sourceOwner, sourceRepo] = p.source.split('/'), [targetOwner, targetRepo] = p.target.split('/');
    return { id: p.id, sourceOwner, sourceRepo, targetOwner, targetRepo };
  }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const registry = loadConfig();
  if (process.env.GITHUB_REPOSITORY !== registry.controllerRepo || process.env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Planning must use trusted controller main');
  }
  const matrix = planPairs(registry, process.env);
  if (!process.env.GITHUB_OUTPUT) throw new Error('Missing workflow output file');
  appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
  console.log(JSON.stringify(matrix));
}
