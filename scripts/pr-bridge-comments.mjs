import { textBlock, wrapProse } from './pr-bridge-reviews.mjs';

export function conversationCopies({ originRepo, originPr, originSide, comments, existing, destinationBot }) {
  return comments.filter(c => c.user?.type === 'User' && ['write', 'admin'].includes(c.bridge_permission))
    .map(c => {
      const marker = `<!-- bridge-conversation:${originRepo}#${originPr}:${c.id} -->`;
      const body = `${marker}\n### ${originSide} comment by ${c.user.login}\n\nOriginal comment: ${c.html_url}\n\nCreated: ${c.created_at} · Updated: ${c.updated_at}\n\n${textBlock(wrapProse(c.body))}\n\nCopied conversation only. Review decisions and merge authority remain at B.`;
      if (body.length > 60000) throw new Error(`Comment ${c.id} is too large to mirror; split the message`);
      const old = existing.find(x => x.user.login === destinationBot && x.body.startsWith(marker + '\n'));
      return { id: old?.id, body, unchanged: old?.body === body };
    }).filter(c => !c.unchanged);
}
