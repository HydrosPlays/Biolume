import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { formatCount } from '@renderer/lib/format';
import '@renderer/test';
import { Field } from './Field';
import { NumberField, parseNumberInput, type NumberFieldProps } from './NumberField';

function Harness({
  initial = 50,
  onChange,
  ...props
}: Partial<NumberFieldProps> & { initial?: number; onChange?: (value: number) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <Field label="Level" hint="Wild level of the target">
      <NumberField
        min={1}
        max={100}
        {...props}
        value={value}
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
    </Field>
  );
}

describe('NumberField', () => {
  it('is a labelled spinbutton exposing its range', () => {
    render(<Harness />);
    const input = screen.getByRole<HTMLInputElement>('spinbutton', { name: 'Level' });
    expect(input.value).toBe('50');
    expect(input.getAttribute('aria-valuenow')).toBe('50');
    expect(input.getAttribute('aria-valuemin')).toBe('1');
    expect(input.getAttribute('aria-valuemax')).toBe('100');
    expect(screen.getByRole('spinbutton', { description: 'Wild level of the target' })).toBe(input);
  });

  it('commits typed text on blur, clamping to max', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole<HTMLInputElement>('spinbutton');

    await user.clear(input);
    await user.type(input, '150');
    // Nothing is committed while typing.
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('150');

    await user.tab();
    expect(onChange).toHaveBeenCalledExactlyOnceWith(100);
    expect(input.value).toBe('100');
  });

  it('commits on Enter, clamping to min', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole<HTMLInputElement>('spinbutton');

    await user.clear(input);
    await user.type(input, '-20{Enter}');

    expect(onChange).toHaveBeenCalledExactlyOnceWith(1);
    expect(input.value).toBe('1');
    expect(document.activeElement).toBe(input);
  });

  it('snaps the display back when the clamped value equals the current one', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={100} onChange={onChange} />);
    const input = screen.getByRole<HTMLInputElement>('spinbutton');

    await user.clear(input);
    await user.type(input, '999{Enter}');

    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('100');
  });

  it('reverts unparsable text and Escape', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole<HTMLInputElement>('spinbutton');

    await user.clear(input);
    await user.type(input, 'abc');
    await user.tab();
    expect(input.value).toBe('50');

    await user.click(input);
    await user.clear(input);
    await user.type(input, '77{Escape}');
    expect(input.value).toBe('50');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('steps with the arrow keys, Shift and Page keys, and jumps with Home / End', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole<HTMLInputElement>('spinbutton');
    await user.click(input);

    await user.keyboard('{ArrowUp}');
    expect(input.value).toBe('51');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(input.value).toBe('49');
    await user.keyboard('{Shift>}{ArrowUp}{/Shift}');
    expect(input.value).toBe('59');
    await user.keyboard('{PageDown}');
    expect(input.value).toBe('49');
    await user.keyboard('{End}');
    expect(input.value).toBe('100');
    await user.keyboard('{ArrowUp}');
    expect(input.value).toBe('100');
    await user.keyboard('{Home}');
    expect(input.value).toBe('1');
    await user.keyboard('{ArrowDown}');
    expect(input.value).toBe('1');
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('steps from the text being typed, not the stale committed value', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole<HTMLInputElement>('spinbutton');

    await user.clear(input);
    await user.type(input, '20{ArrowUp}');
    expect(input.value).toBe('21');
  });

  it('steps with the stepper buttons and disables them at the bounds', () => {
    const onChange = vi.fn();
    render(<Harness initial={99} onChange={onChange} />);
    const increase = screen.getByRole('button', { name: 'Increase' });
    const decrease = screen.getByRole('button', { name: 'Decrease' });

    fireEvent.pointerDown(increase, { button: 0 });
    fireEvent.pointerUp(increase);
    expect(onChange).toHaveBeenLastCalledWith(100);
    expect(increase).toHaveProperty('disabled', true);
    expect(decrease).toHaveProperty('disabled', false);

    fireEvent.pointerDown(decrease, { button: 0 });
    fireEvent.pointerUp(decrease);
    expect(onChange).toHaveBeenLastCalledWith(99);
    // Steppers are mouse conveniences, not tab stops.
    expect(increase.getAttribute('tabindex')).toBe('-1');
  });

  it('repeats while a stepper is held and stops on release', () => {
    vi.useFakeTimers();
    try {
      const onChange = vi.fn();
      render(<Harness initial={10} onChange={onChange} />);
      const increase = screen.getByRole('button', { name: 'Increase' });

      fireEvent.pointerDown(increase, { button: 0 });
      expect(onChange).toHaveBeenCalledTimes(1);
      act(() => vi.advanceTimersByTime(380 + 55 * 3 + 10));
      expect(onChange).toHaveBeenCalledTimes(4);
      expect(onChange).toHaveBeenLastCalledWith(14);

      fireEvent.pointerUp(window);
      act(() => vi.advanceTimersByTime(1000));
      expect(onChange).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('changes with the wheel only while focused', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole<HTMLInputElement>('spinbutton');

    fireEvent.wheel(input, { deltaY: -100 });
    expect(input.value).toBe('50');

    await user.click(input);
    fireEvent.wheel(input, { deltaY: -100 });
    expect(input.value).toBe('51');
    fireEvent.wheel(input, { deltaY: 100 });
    fireEvent.wheel(input, { deltaY: 100 });
    expect(input.value).toBe('49');
  });

  it('respects step precision and custom formatting', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={0.5} min={0} max={1} step={0.05} onChange={onChange} />);
    const input = screen.getByRole<HTMLInputElement>('spinbutton');
    expect(input.value).toBe('0.50');

    await user.click(input);
    await user.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenLastCalledWith(0.55);

    await user.clear(input);
    await user.type(input, '0.333{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(0.33);
  });

  it('shows the formatted value at rest and parses separators when typed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness initial={12345} min={0} max={99_999_999} format={formatCount} onChange={onChange} />,
    );
    const input = screen.getByRole<HTMLInputElement>('spinbutton');
    expect(input.value).toBe('12,345');

    await user.clear(input);
    await user.type(input, '1,000,000{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(1_000_000);
    expect(input.value).toBe('1,000,000');
  });

  it('ignores input while disabled', () => {
    render(<Harness disabled />);
    expect(screen.getByRole<HTMLInputElement>('spinbutton')).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Increase' })).toHaveProperty('disabled', true);
  });
});

describe('parseNumberInput', () => {
  it('parses plain, signed, separated and decimal-comma numbers', () => {
    expect(parseNumberInput('42')).toBe(42);
    expect(parseNumberInput(' 1 234 ')).toBe(1234);
    expect(parseNumberInput('1,234,567')).toBe(1_234_567);
    expect(parseNumberInput('3,5')).toBe(3.5);
    expect(parseNumberInput('-7')).toBe(-7);
    expect(parseNumberInput('−7')).toBe(-7);
    expect(parseNumberInput('+.5')).toBe(0.5);
    expect(parseNumberInput('12.')).toBe(12);
  });

  it('rejects everything else', () => {
    for (const text of ['', '  ', 'abc', '1e5', '1.2.3', '--3', 'Infinity', '12px']) {
      expect(parseNumberInput(text), text).toBeNull();
    }
  });
});
