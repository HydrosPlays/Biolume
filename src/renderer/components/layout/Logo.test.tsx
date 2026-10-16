import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Logo } from './Logo';

describe('Logo', () => {
  it('is decorative by default, so "Biolume" is not announced twice next to the wordmark', () => {
    const { container } = render(<Logo size={22} />);
    const wrapper = container.firstElementChild;
    const image = container.querySelector('img');

    expect(wrapper?.getAttribute('aria-hidden')).toBe('true');
    expect(image?.getAttribute('alt')).toBe('');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('renders the pre-scaled icon at the requested size and lets the browser pick by DPI', () => {
    const { container } = render(<Logo size={44} />);
    const image = container.querySelector('img');

    expect(image?.getAttribute('width')).toBe('44');
    expect(image?.getAttribute('height')).toBe('44');
    expect(image?.getAttribute('sizes')).toBe('44px');
    expect(image?.getAttribute('srcset')).toMatch(
      /icon-22.*22w, .*icon-32.*32w, .*icon-44.*44w, .*icon-64.*64w, .*icon-128.*128w/,
    );
  });

  it('becomes a named image when given a label', () => {
    render(<Logo label="Biolume" />);
    expect(screen.getByRole('img', { name: 'Biolume' })).not.toBeNull();
  });
});
