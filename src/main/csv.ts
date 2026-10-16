/**
 * RFC 4180 CSV writing and parsing.
 *
 * Output is UTF-8 with a BOM and CRLF line endings so Excel opens it correctly.
 * Text cells are guarded against spreadsheet formula injection: a cell that a
 * spreadsheet would evaluate (leading `=`, `+`, `-`, `@`, TAB or CR) is written
 * with a single quote in front, and {@link unguardFormula} removes it on import.
 */

export const CSV_BOM = '\uFEFF';

export type CsvValue = string | number | boolean | null | undefined;
export type CsvDelimiter = ',' | ';' | '\t';

/**
 * Cells that already start with quotes before a trigger character are guarded
 * too — otherwise `'=x` and a guarded `=x` would be indistinguishable on import.
 */
const NEEDS_GUARD = /^'*[=+\-@\t\r]/;
const IS_GUARDED = /^'+[=+\-@\t\r]/;

export function guardFormula(text: string): string {
  return NEEDS_GUARD.test(text) ? `'${text}` : text;
}

/** Inverse of {@link guardFormula}. */
export function unguardFormula(text: string): string {
  return IS_GUARDED.test(text) ? text.slice(1) : text;
}

/**
 * One cell, guarded and quoted as needed. Numbers and booleans are written
 * bare (they cannot carry a formula); null / undefined become an empty cell.
 */
export function formatCsvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const guarded = guardFormula(value);
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/** Header + rows → a complete CSV document (BOM, CRLF after every record). */
export function toCsv(header: readonly string[], rows: readonly (readonly CsvValue[])[]): string {
  const lines = [header, ...rows].map((row) => row.map(formatCsvCell).join(','));
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}

const QUOTE = 34;
const LF = 10;
const CR = 13;

/**
 * Picks the delimiter from the first record: spreadsheets in many locales save
 * "CSV" with semicolons, and some tools use tabs. Comma wins ties.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && (char === ',' || char === ';' || char === '\t')) counts[char] += 1;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[','] && counts['\t'] > counts[';']) return '\t';
  return ',';
}

export interface ParseCsvOptions {
  /** Field separator; detected from the first record when omitted. */
  delimiter?: CsvDelimiter;
}

/**
 * Parses CSV text into records of string cells. Handles quoted fields with
 * doubled quotes, delimiters and line breaks inside quotes, a leading BOM and
 * CRLF / LF / CR record separators. Blank lines are skipped. Malformed input
 * never throws: an unterminated quote runs to the end of the text, and stray
 * characters after a closing quote are kept as part of the field.
 */
export function parseCsv(text: string, options: ParseCsvOptions = {}): string[][] {
  const input = text.startsWith(CSV_BOM) ? text.slice(1) : text;
  const delimiter = options.delimiter ?? detectDelimiter(input);
  const delimiterCode = delimiter.charCodeAt(0);
  const length = input.length;

  /** Index of the next delimiter or line break at or after `from` (or the end of the text). */
  const endOfBareText = (from: number): number => {
    let index = from;
    while (index < length) {
      const code = input.charCodeAt(index);
      if (code === delimiterCode || code === LF || code === CR) break;
      index += 1;
    }
    return index;
  };

  const records: string[][] = [];
  let record: string[] = [];
  let recordHasQuotedField = false;
  let position = 0;

  const finishRecord = (): void => {
    const blank = record.length === 1 && record[0] === '' && !recordHasQuotedField;
    if (!blank) records.push(record);
    record = [];
    recordHasQuotedField = false;
  };

  // Each iteration starts at the first character of a field.
  for (;;) {
    if (position >= length) {
      // The text ended right after a delimiter: that delimiter introduced one more, empty, field.
      if (record.length > 0) {
        record.push('');
        finishRecord();
      }
      break;
    }

    let field: string;
    if (input.charCodeAt(position) === QUOTE) {
      recordHasQuotedField = true;
      field = '';
      let cursor = position + 1;
      for (;;) {
        const close = input.indexOf('"', cursor);
        if (close === -1) {
          field += input.slice(cursor);
          cursor = length;
          break;
        }
        field += input.slice(cursor, close);
        if (input.charCodeAt(close + 1) === QUOTE) {
          field += '"';
          cursor = close + 2;
          continue;
        }
        cursor = close + 1;
        break;
      }
      const end = endOfBareText(cursor);
      field += input.slice(cursor, end);
      position = end;
    } else {
      const end = endOfBareText(position);
      field = input.slice(position, end);
      position = end;
    }
    record.push(field);

    if (position >= length) {
      finishRecord();
      break;
    }
    const terminator = input.charCodeAt(position);
    if (terminator === delimiterCode) {
      position += 1;
      continue;
    }
    position += terminator === CR && input.charCodeAt(position + 1) === LF ? 2 : 1;
    finishRecord();
  }

  return records;
}
