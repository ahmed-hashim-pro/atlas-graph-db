import { AtlasError } from '@atlas/core';

export interface ImportNode {
  tempId: string;
  labels: string[];
  properties: Record<string, string | number | boolean>;
}
export interface ImportEdge {
  from: string;
  to: string;
  type: string;
  properties: Record<string, string | number | boolean>;
}

/** Minimal RFC-4180-ish CSV: quoted fields, "" escapes, comma/newline aware. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = (): void => {
    row.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };
  const src = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (i < src.length) {
    const c = src[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === ',') {
      pushField();
      i++;
    } else if (c === '\n') {
      pushRow();
      i++;
    } else {
      field += c;
      i++;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

interface TypedCol {
  name: string;
  type: 'string' | 'number' | 'boolean';
}

function coerce(raw: string, type: TypedCol['type'], col: string): string | number | boolean {
  if (type === 'number') {
    const n = Number(raw);
    if (!Number.isFinite(n))
      throw new AtlasError('VALIDATION', `column "${col}": "${raw}" is not a number`);
    return n;
  }
  if (type === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new AtlasError('VALIDATION', `column "${col}": "${raw}" is not a boolean`);
  }
  return raw;
}

function typedCol(header: string): TypedCol {
  const idx = header.indexOf(':');
  if (idx === -1) return { name: header, type: 'string' };
  const name = header.slice(0, idx);
  const t = header.slice(idx + 1);
  if (t !== 'string' && t !== 'number' && t !== 'boolean')
    throw new AtlasError('VALIDATION', `unknown column type "${t}" in header "${header}"`);
  return { name, type: t };
}

export function parseNodesCsv(text: string): ImportNode[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const headers = rows[0]!;
  const tempIdx = headers.indexOf('tempId');
  const labelIdx = headers.indexOf(':label');
  if (tempIdx === -1) throw new AtlasError('VALIDATION', 'nodes CSV requires a "tempId" column');
  if (labelIdx === -1) throw new AtlasError('VALIDATION', 'nodes CSV requires a ":label" column');
  const propCols = headers
    .map((h, i) => ({ i, h }))
    .filter((c) => c.i !== tempIdx && c.i !== labelIdx)
    .map((c) => ({ i: c.i, col: typedCol(c.h) }));
  return rows.slice(1).map((r) => {
    const properties: Record<string, string | number | boolean> = {};
    for (const { i, col } of propCols) {
      const raw = r[i] ?? '';
      if (raw === '') continue;
      properties[col.name] = coerce(raw, col.type, col.name);
    }
    return {
      tempId: r[tempIdx] ?? '',
      labels: (r[labelIdx] ?? '').split('|').filter((l) => l.length > 0),
      properties,
    };
  });
}

export function parseEdgesCsv(text: string): ImportEdge[] {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const headers = rows[0]!;
  const fromIdx = headers.indexOf(':from');
  const toIdx = headers.indexOf(':to');
  const typeIdx = headers.indexOf(':type');
  if (fromIdx === -1 || toIdx === -1)
    throw new AtlasError('VALIDATION', 'edges CSV requires :from and :to columns');
  if (typeIdx === -1) throw new AtlasError('VALIDATION', 'edges CSV requires a :type column');
  const propCols = headers
    .map((h, i) => ({ i, h }))
    .filter((c) => ![fromIdx, toIdx, typeIdx].includes(c.i))
    .map((c) => ({ i: c.i, col: typedCol(c.h) }));
  return rows.slice(1).map((r) => {
    const properties: Record<string, string | number | boolean> = {};
    for (const { i, col } of propCols) {
      const raw = r[i] ?? '';
      if (raw === '') continue;
      properties[col.name] = coerce(raw, col.type, col.name);
    }
    return { from: r[fromIdx] ?? '', to: r[toIdx] ?? '', type: r[typeIdx] ?? '', properties };
  });
}
