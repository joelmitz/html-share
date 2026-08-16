// 既読マークの正規化。Worker 本体とテストの両方から使う純粋関数のみを置く。

function isoOrNull(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

function clean(value: unknown, name: string, maximum: number): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (result.length > maximum) throw Object.assign(new Error(`${name} is too long`), { statusCode: 400 });
  return result;
}

export function cleanReadMark(value: unknown): { v: string | null; at: string } | null {
  const legacy = typeof value === 'string' ? isoOrNull(value) : null;
  if (legacy) return { v: legacy, at: legacy };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { v?: unknown; at?: unknown };
  const at = isoOrNull(record.at);
  return at ? { v: isoOrNull(record.v), at } : null;
}

export function cleanReadMarks(value: unknown, maximum: number): Record<string, { v: string | null; at: string }> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw Object.assign(new Error('readMarks is invalid'), { statusCode: 400 });
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > maximum) throw Object.assign(new Error('readMarks is too large'), { statusCode: 400 });
  const marks: Record<string, { v: string | null; at: string }> = {};
  for (const [source, mark] of entries) {
    const key = clean(source, 'source', 500);
    const cleaned = cleanReadMark(mark);
    if (!key || !cleaned) continue;
    marks[key] = cleaned;
  }
  return marks;
}
