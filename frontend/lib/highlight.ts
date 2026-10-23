export interface Segment {
  text: string;
  marked: boolean;
}

/**
 * Split `text` into segments, marking every case-insensitive occurrence of the
 * given quotes. Overlapping matches are merged.
 */
export function highlightQuotes(text: string, quotes: string[]): Segment[] {
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const raw of quotes) {
    const q = raw
      .trim()
      .replace(/[.…]+$/, "")
      .toLowerCase();
    if (q.length < 3) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(q, from);
      if (at === -1) break;
      ranges.push([at, at + q.length]);
      from = at + q.length;
    }
  }
  if (!ranges.length) return [{ text, marked: false }];
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const out: Segment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) out.push({ text: text.slice(cursor, start), marked: false });
    out.push({ text: text.slice(start, end), marked: true });
    cursor = end;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), marked: false });
  return out;
}
