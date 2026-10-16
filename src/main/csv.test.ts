import { describe, expect, it } from 'vitest';
import {
  CSV_BOM,
  detectDelimiter,
  formatCsvCell,
  guardFormula,
  parseCsv,
  toCsv,
  unguardFormula,
} from './csv';

describe('formatCsvCell', () => {
  it('writes plain text, numbers and booleans bare', () => {
    expect(formatCsvCell('Pikachu')).toBe('Pikachu');
    expect(formatCsvCell(4096)).toBe('4096');
    expect(formatCsvCell(0.5)).toBe('0.5');
    expect(formatCsvCell(true)).toBe('true');
    expect(formatCsvCell(false)).toBe('false');
  });

  it('writes null, undefined and non-finite numbers as an empty cell', () => {
    expect(formatCsvCell(null)).toBe('');
    expect(formatCsvCell(undefined)).toBe('');
    expect(formatCsvCell(Number.NaN)).toBe('');
    expect(formatCsvCell(Number.POSITIVE_INFINITY)).toBe('');
  });

  it('quotes fields containing a comma, quote, CR or LF and doubles the quotes', () => {
    expect(formatCsvCell('a,b')).toBe('"a,b"');
    expect(formatCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(formatCsvCell('line 1\nline 2')).toBe('"line 1\nline 2"');
    expect(formatCsvCell('line 1\r\nline 2')).toBe('"line 1\r\nline 2"');
    expect(formatCsvCell('a\rb')).toBe('"a\rb"');
  });

  it('does not guard numbers, so negative values stay numeric', () => {
    expect(formatCsvCell(-5)).toBe('-5');
  });
});

describe('formula guard', () => {
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])(
    'prefixes %j with a single quote',
    (cell) => {
      expect(guardFormula(cell)).toBe(`'${cell}`);
      expect(unguardFormula(guardFormula(cell))).toBe(cell);
    },
  );

  it('leaves harmless text alone', () => {
    for (const cell of ['', 'hello', "it's", '1+1', 'a=b', ' =x', "'quoted'"]) {
      expect(guardFormula(cell)).toBe(cell);
      expect(unguardFormula(cell)).toBe(cell);
    }
  });

  it('keeps text that already starts with a quote and a trigger distinguishable', () => {
    for (const cell of ["'=x", "''=x", "'-5", "'@a"]) {
      const guarded = guardFormula(cell);
      expect(guarded).toBe(`'${cell}`);
      expect(unguardFormula(guarded)).toBe(cell);
    }
  });

  it('is applied by formatCsvCell before quoting', () => {
    expect(formatCsvCell('=HYPERLINK("http://evil","x")')).toBe(
      `"'=HYPERLINK(""http://evil"",""x"")"`,
    );
    expect(formatCsvCell('-2,3')).toBe(`"'-2,3"`);
  });
});

describe('toCsv', () => {
  it('starts with a BOM and ends every record with CRLF', () => {
    const csv = toCsv(
      ['a', 'b'],
      [
        [1, 'x'],
        [2, null],
      ],
    );
    expect(csv).toBe(`${CSV_BOM}a,b\r\n1,x\r\n2,\r\n`);
  });

  it('produces a header-only file for no rows', () => {
    expect(toCsv(['a', 'b'], [])).toBe(`${CSV_BOM}a,b\r\n`);
  });
});

describe('parseCsv', () => {
  it('parses simple records', () => {
    expect(parseCsv('a,b,c\r\n1,2,3\r\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('strips a leading BOM', () => {
    expect(parseCsv(`${CSV_BOM}a,b\r\n1,2`)).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('accepts LF, CRLF and CR record separators', () => {
    const expected = [
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ];
    expect(parseCsv('a,b\n1,2\n3,4\n')).toEqual(expected);
    expect(parseCsv('a,b\r\n1,2\r\n3,4')).toEqual(expected);
    expect(parseCsv('a,b\r1,2\r3,4\r')).toEqual(expected);
  });

  it('handles quoted fields with delimiters, doubled quotes and embedded line breaks', () => {
    const text = 'name,notes\r\n"Mr. Mime, Jr.","said ""hi""\r\nthen left\nfor good"\r\n';
    expect(parseCsv(text)).toEqual([
      ['name', 'notes'],
      ['Mr. Mime, Jr.', 'said "hi"\r\nthen left\nfor good'],
    ]);
  });

  it('keeps empty fields, including a trailing one', () => {
    expect(parseCsv('a,,c\n,,\nx,')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
      ['x', ''],
    ]);
  });

  it('skips blank lines but keeps a record that is one quoted empty field', () => {
    expect(parseCsv('a\n\n\r\nb\n""\n')).toEqual([['a'], ['b'], ['']]);
  });

  it('returns no records for empty input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv(CSV_BOM)).toEqual([]);
    expect(parseCsv('\r\n\r\n')).toEqual([]);
  });

  it('does not throw on malformed quoting', () => {
    // Unterminated quote: the field runs to the end of the text.
    expect(parseCsv('a,"b\nc')).toEqual([['a', 'b\nc']]);
    // Characters after a closing quote stay part of the field.
    expect(parseCsv('"a"b,c')).toEqual([['ab', 'c']]);
    // A quote in the middle of a bare field is literal.
    expect(parseCsv('a"b,c')).toEqual([['a"b', 'c']]);
  });

  it('detects semicolon- and tab-separated files', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a,b,c')).toBe(',');
    expect(detectDelimiter('"a;b;c",d')).toBe(',');
    expect(detectDelimiter('single')).toBe(',');
    expect(parseCsv('a;b\n"x;y";2')).toEqual([
      ['a', 'b'],
      ['x;y', '2'],
    ]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('honours an explicit delimiter', () => {
    expect(parseCsv('a;b,c', { delimiter: ',' })).toEqual([['a;b', 'c']]);
  });
});

describe('round trip', () => {
  const nasty = [
    '',
    'plain',
    'comma, inside',
    '"quoted"',
    'trailing quote"',
    'line\nbreak',
    'windows\r\nbreak',
    'old mac\rbreak',
    '=SUM(1,2)',
    '+41 22 000',
    '-dash',
    '@handle',
    '\ttabbed',
    '\rcarriage',
    "'=already guarded",
    "it's fine",
    ' padded ',
    'emoji ✨ and ünïcödé',
    ';semi;colons;',
    '""',
    ',',
  ];

  it('restores every awkward string exactly', () => {
    const rows = nasty.map((value, index) => [index, value, value]);
    const parsed = parseCsv(toCsv(['index', 'first', 'second'], rows));
    expect(parsed[0]).toEqual(['index', 'first', 'second']);
    // Blank-line skipping must not swallow the row whose text cells are empty.
    expect(parsed).toHaveLength(nasty.length + 1);
    nasty.forEach((value, index) => {
      const record = parsed[index + 1];
      expect(record?.[0]).toBe(String(index));
      expect(unguardFormula(record?.[1] ?? 'missing')).toBe(value);
      expect(unguardFormula(record?.[2] ?? 'missing')).toBe(value);
    });
  });

  it('never leaves a formula trigger at the start of an exported text cell', () => {
    const parsed = parseCsv(
      toCsv(
        ['value'],
        nasty.map((value) => [value]),
      ),
    );
    for (const record of parsed.slice(1)) {
      expect(record[0] ?? '').not.toMatch(/^[=+\-@\t\r]/);
    }
  });

  it('copes with a large file in reasonable time', () => {
    const rows = Array.from({ length: 20_000 }, (_, index) => [
      index,
      `note "${index}", with\nbreak`,
      'x',
    ]);
    const parsed = parseCsv(toCsv(['id', 'note', 'flag'], rows));
    expect(parsed).toHaveLength(20_001);
    expect(parsed[20_000]).toEqual(['19999', 'note "19999", with\nbreak', 'x']);
  });
});
