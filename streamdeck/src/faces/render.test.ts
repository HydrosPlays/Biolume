import { describe, expect, it } from 'vitest';
import { HUNT } from '../bridge/testFixtures';
import { KEY_KINDS } from '../keys/kinds';
import { escapeXml, formatCount, truncate } from './format';
import { renderKey, svgDataUrl, type KeyView } from './render';

/** Minimal well-formedness check: every tag closes in order, attributes are quoted. */
function assertWellFormed(svg: string): void {
  const stack: string[] = [];
  const tags = svg.matchAll(/<(\/?)([a-zA-Z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g);
  let consumed = 0;
  for (const match of tags) {
    const [whole, closing, name, , selfClosing] = match;
    const between = svg.slice(consumed, match.index);
    expect(between, `stray markup before <${closing}${name}>`).not.toMatch(/[<>]/);
    consumed = (match.index ?? 0) + whole.length;
    if (selfClosing) continue;
    if (closing) expect(stack.pop()).toBe(name);
    else stack.push(name ?? '');
  }
  expect(svg.slice(consumed)).toBe('');
  expect(stack).toEqual([]);
}

const ONLINE: KeyView = { connection: 'online', hunt: HUNT, armed: null, sprite: null };
const SPRITE = 'data:image/png;base64,iVBORw0KGgo=';

describe('formatCount', () => {
  it.each([
    [0, '0'],
    [7, '7'],
    [9_999, '9999'],
    [10_000, '10k'],
    [12_345, '12.3k'],
    [12_399, '12.3k'],
    [99_999, '99.9k'],
    [100_000, '100k'],
    [123_456, '123k'],
    [999_999, '999k'],
    [1_000_000, '1M'],
    [1_250_000, '1.2M'],
    [12_345_678, '12M'],
    [99_999_999, '99M'],
    [-5, '0'],
    [Number.NaN, '0'],
  ])('%d -> %s', (value, expected) => {
    expect(formatCount(value)).toBe(expected);
  });
});

describe('truncate / escapeXml', () => {
  it('truncates by code point with an ellipsis', () => {
    expect(truncate('Charizard', 12)).toBe('Charizard');
    expect(truncate('Crabominable', 8)).toBe('Crabomi…');
    expect(truncate('✨✨✨✨', 3)).toBe('✨✨…');
  });

  it('escapes every XML-significant character', () => {
    expect(escapeXml(`<a href="x" onload='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onload=&apos;y&apos;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('renderKey', () => {
  const views: KeyView[] = [
    { connection: 'offline' },
    { connection: 'incompatible' },
    { connection: 'online', hunt: null, armed: null, sprite: null },
    ONLINE,
    { ...ONLINE, sprite: SPRITE },
    { ...ONLINE, hunt: { ...HUNT, status: 'completed', count: 123_456 } },
    { ...ONLINE, armed: { remainingMs: 2_400, fraction: 0.8 } },
    { ...ONLINE, armed: { remainingMs: 3_000, fraction: 1 } },
  ];

  it('draws well-formed SVG for every key in every situation', () => {
    for (const kind of KEY_KINDS) {
      for (const view of views) {
        const svg = renderKey(kind, view);
        expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
        assertWellFormed(svg);
      }
    }
  });

  it('shows "Offline" on every key when Biolume is not reachable', () => {
    for (const kind of KEY_KINDS) {
      expect(renderKey(kind, { connection: 'offline' })).toContain('>Offline</text>');
      expect(renderKey(kind, { connection: 'incompatible' })).toContain('>Update</text>');
    }
  });

  it('shows the count big and the target name small on the counter key', () => {
    const svg = renderKey('counter', ONLINE);
    expect(svg).toContain('>1234</text>');
    expect(svg).toContain('>Ralts</text>');
    expect(svg).toContain('>Phase 2</text>');
    expect(renderKey('counter', { ...ONLINE, hunt: { ...HUNT, count: 12_345 } })).toContain(
      '>12.3k</text>',
    );
  });

  it('falls back to the hunt name without a target, and embeds the sprite when there is one', () => {
    expect(renderKey('counter', { ...ONLINE, hunt: { ...HUNT, targetName: null } })).toContain(
      '>Ralts hunt</text>',
    );
    const withSprite = renderKey('counter', { ...ONLINE, sprite: SPRITE });
    expect(withSprite).toContain(`xlink:href="${SPRITE}"`);
    expect(withSprite).toContain('>P2</text>');
  });

  it('turns gold for a completed hunt', () => {
    const svg = renderKey('counter', { ...ONLINE, hunt: { ...HUNT, status: 'completed' } });
    expect(svg).toContain('#ffd866');
    expect(svg).toContain('>Found!</text>');
  });

  it('escapes hostile names instead of injecting markup', () => {
    const svg = renderKey('counter', {
      ...ONLINE,
      hunt: { ...HUNT, targetName: '<script>alert(1)</script>' },
    });
    expect(svg).not.toContain('<script');
    expect(svg).toContain('&lt;script&gt;');
    assertWellFormed(svg);
  });

  it('shows "Confirm?" with a countdown while Shiny Found is armed, gold throughout', () => {
    const svg = renderKey('shinyfound', {
      ...ONLINE,
      armed: { remainingMs: 2_100, fraction: 0.7 },
    });
    expect(svg).toContain('>Confirm?</text>');
    expect(svg).toContain('>3</text>');
    expect(svg).not.toContain('#2ee8ff');
    expect(renderKey('shinyfound', ONLINE)).toContain('>Shiny!</text>');
    expect(
      renderKey('shinyfound', { ...ONLINE, hunt: { ...HUNT, status: 'completed' } }),
    ).toContain('>Found!</text>');
  });

  it('labels action keys with the live step and phase', () => {
    const hunt = { ...HUNT, step: 5, phaseNumber: 4 };
    expect(renderKey('increment', { ...ONLINE, hunt })).toContain('>+5</text>');
    expect(renderKey('decrement', { ...ONLINE, hunt })).toContain('>−5</text>');
    expect(renderKey('logphase', { ...ONLINE, hunt })).toContain('>Phase 4</text>');
  });

  it('marks hunt keys "No hunt" without an active hunt, but keeps the overlay toggle live', () => {
    const none: KeyView = { connection: 'online', hunt: null, armed: null, sprite: null };
    expect(renderKey('increment', none)).toContain('>No hunt</text>');
    expect(renderKey('overlay', none)).toContain('>Overlay</text>');
  });

  it('svgDataUrl encodes the markup losslessly', () => {
    const svg = renderKey('counter', ONLINE);
    const url = svgDataUrl(svg);
    expect(url.startsWith('data:image/svg+xml,')).toBe(true);
    expect(url).not.toMatch(/[<>"#\s]/);
    expect(decodeURIComponent(url.slice('data:image/svg+xml,'.length))).toBe(svg);
  });
});
