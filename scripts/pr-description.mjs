import { createHash } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
export function descriptionParts(source, a, previous = '') {
  const sourceBody = a.body ?? '';
  const marker = `<!-- b-authoritative-bridge:${source}#${a.number} -->`;
  const separator = `\n\n${marker}\n---\n`;
  const notesMarker = `<!-- bridge-target-notes:${source}#${a.number} -->`;
  if (sourceBody.includes(separator) || sourceBody.includes(notesMarker)) throw new Error('Source description contains reserved bridge delimiters');
  let notes = previous;
  const offset = previous.indexOf(separator);
  if (offset !== -1) {
    if (previous.indexOf(separator, offset + separator.length) !== -1) throw new Error('Ambiguous managed description; preserve it and inspect delimiters');
    const footer = previous.slice(offset + separator.length);
    const end = footer.indexOf(notesMarker);
    const digest = /<!-- bridge-managed-source:([a-f0-9]{64}) -->/.exec(footer.slice(0, end));
    if (end < 0 || !digest) throw new Error('Managed description delimiters changed; restore them before retry');
    notes = footer.slice(end + notesMarker.length);
    const original = previous.slice(0, offset);
    if (hash(original) !== digest[1]) {
      notes += `\n\n### Description edited at TechX (preserved)\n\n${original}`;
    }
  } else if (previous) {
    // Never discard a pre-upgrade description: it may contain maintainer edits.
    notes = `\n\n### TechX maintainer notes\n\n${previous}`;
  } else {
    notes = '\n\n### TechX maintainer notes\n\n<!-- Maintainers: add your own notes here. This section is preserved. -->';
  }
  const body = `${sourceBody}${separator}Contribution from [${source}#${a.number}](https://github.com/${source}/pull/${a.number}). Original author: **${a.user?.login ?? 'unknown'}**.\n\n**Merge requirement:** use **Create a merge commit**. Do not squash or rebase: original commit SHAs, authors and committers must be preserved. TechX decides acceptance; XBrain follows accepted TechX history.\n\nThe description above follows XBrain. Add TechX-only notes below; edits to the source section at TechX are moved into the notes on the next sync.\n<!-- bridge-managed-source:${hash(sourceBody)} -->\n${notesMarker}${notes}`;
  if (body.length > 60000) throw new Error('Combined PR description exceeds the safe limit; shorten the source body or maintainer notes before retry');
  return { body, notes };
}

export async function syncDescription({ source, target, a, b, bot, api }) {
  if (b.user?.login !== bot || b.head.ref !== `incoming/a-pr-${a.number}` || b.head.repo?.full_name !== target) {
    throw new Error('Description update requires the paired bot-created contribution PR');
  }
  const result = descriptionParts(source, a, b.body ?? '');
  if (result.body === b.body) return result.notes;
  const latestA = await api(source, `/pulls/${a.number}`);
  const latestB = await api(target, `/pulls/${b.number}`);
  if ((latestA.body ?? '') !== (a.body ?? '') || (latestB.body ?? '') !== (b.body ?? '') || latestB.user?.login !== bot
      || latestB.head.ref !== b.head.ref || latestB.head.repo?.full_name !== target) {
    throw new Error('PR description changed during reconciliation; retry with a fresh snapshot');
  }
  await api(target, `/pulls/${b.number}`, { method: 'PATCH', body: { body: result.body } });
  const verified = await api(target, `/pulls/${b.number}`);
  if (verified.body !== result.body) throw new Error('PR description read-back mismatch');
  b.body = result.body;
  return result.notes;
}
