// Display-only tidying of text lifted from notes, so markdown leftovers do not show: heading marks on a title, footnote numbers, wikilink brackets, emphasis underscores.
// The stored text is never changed; this only affects what is drawn.
export const tidyTitle = t => String(t || '').replace(/^\s*#{1,6}\s+/, '').trim();
export const tidyQuote = t => String(t || '').replace(/<br\s*\/?>/gi, ' · ').replace(/\\\|/g, '').replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1').replace(/\[\d{1,3}\]/g, '')
  .replace(/(^|\W)_+(?=\S)/g, '$1').replace(/(?<=\S)_+(?=\W|$)/g, '').replace(/(^|\s)[|*](?=\s|$)/g, '$1').replace(/\s{2,}/g, ' ').replace(/^[·\s]+|[·\s]+$/g, '').replace(/(\s·)+(?=\s·)/g, '').trim();
