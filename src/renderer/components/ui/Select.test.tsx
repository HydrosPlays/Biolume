import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { isKeyboardCaptured } from '@renderer/hooks/useKeyboardCapture';
import '@renderer/test';
import { Field } from './Field';
import { Select, type SelectItem } from './Select';

const GAMES: SelectItem[] = [
  {
    label: 'Generation 9',
    options: [
      {
        value: 'sv',
        label: 'Scarlet / Violet',
        description: 'Open-world Paldea',
        meta: '2022',
        keywords: 'SV',
      },
      { value: 'pla', label: 'Legends: Arceus', meta: '2022' },
    ],
  },
  {
    label: 'Generation 8',
    options: [
      { value: 'swsh', label: 'Sword / Shield', meta: '2019' },
      { value: 'bdsp', label: 'Brilliant Diamond / Shining Pearl', meta: '2021', disabled: true },
      { value: 'lgpe', label: "Let's Go, Pikachu! / Eevee!", meta: '2018' },
    ],
  },
  { value: 'custom', label: 'Custom odds' },
];

function Harness({
  initial = null,
  onChange,
}: {
  initial?: string | null;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <Field label="Game">
      <Select
        options={GAMES}
        value={value}
        placeholder="Choose a game"
        onChange={(next) => {
          setValue(next);
          onChange?.(next);
        }}
      />
    </Field>
  );
}

function activeOption(): HTMLElement | null {
  const id = screen.getByRole('combobox').getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
}

describe('Select', () => {
  it('is a labelled, collapsed combobox showing the placeholder', () => {
    render(<Harness />);
    const trigger = screen.getByRole('combobox', { name: 'Game' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger?.textContent).toContain('Choose a game');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens on ArrowDown with groups, descriptions and meta, focus staying on the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('combobox');
    trigger.focus();

    await user.keyboard('{ArrowDown}');

    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(trigger);
    const listbox = screen.getByRole('listbox', { name: 'Game' });
    expect(trigger.getAttribute('aria-controls')).toBe(listbox.id);
    expect(within(listbox).getAllByRole('option')).toHaveLength(6);

    const group = within(listbox).getByRole('group', { name: 'Generation 9' });
    expect(within(group).getAllByRole('option')).toHaveLength(2);
    expect(within(listbox).getByText('Open-world Paldea')).not.toBeNull();
    expect(activeOption()?.textContent).toContain('Scarlet / Violet');
  });

  it('moves with arrows, skips disabled options and does not wrap', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('combobox').focus();

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowDown}');
    expect(activeOption()?.textContent).toContain('Legends: Arceus');
    await user.keyboard('{ArrowDown}');
    expect(activeOption()?.textContent).toContain('Sword / Shield');
    // BDSP is disabled.
    await user.keyboard('{ArrowDown}');
    expect(activeOption()?.textContent).toContain("Let's Go");
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(activeOption()?.textContent).toContain('Custom odds');

    await user.keyboard('{Home}');
    expect(activeOption()?.textContent).toContain('Scarlet / Violet');
    await user.keyboard('{ArrowUp}');
    expect(activeOption()?.textContent).toContain('Scarlet / Violet');
    await user.keyboard('{End}');
    expect(activeOption()?.textContent).toContain('Custom odds');
  });

  it('selects with Enter, closes and reports the value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByRole('combobox');
    trigger.focus();

    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');

    expect(onChange).toHaveBeenCalledExactlyOnceWith('pla');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger?.textContent).toContain('Legends: Arceus');
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('reopens on the selected option and marks it selected', async () => {
    const user = userEvent.setup();
    render(<Harness initial="swsh" />);
    screen.getByRole('combobox').focus();

    await user.keyboard(' ');

    expect(activeOption()?.textContent).toContain('Sword / Shield');
    expect(
      screen.getByRole('option', { name: /Sword \/ Shield/ }).getAttribute('aria-selected'),
    ).toBe('true');
    expect(
      screen.getByRole('option', { name: /Legends: Arceus/ }).getAttribute('aria-selected'),
    ).toBe('false');
  });

  it('closes on Escape without selecting', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="sv" onChange={onChange} />);
    const trigger = screen.getByRole('combobox');
    trigger.focus();

    await user.keyboard('{ArrowDown}{ArrowDown}{Escape}');

    expect(onChange).not.toHaveBeenCalled();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger?.textContent).toContain('Scarlet / Violet');
  });

  it('supports type-ahead on labels and keywords, opening when closed', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByRole('combobox');
    trigger.focus();

    await user.keyboard('le');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(activeOption()?.textContent).toContain('Legends: Arceus');

    await user.keyboard('{Escape}');
    await user.keyboard('cu{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('custom');
  });

  it('cycles through matches when one letter is repeated', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    screen.getByRole('combobox').focus();

    await user.keyboard('{ArrowDown}');
    await user.keyboard('s');
    expect(activeOption()?.textContent).toContain('Sword / Shield');
    await user.keyboard('s');
    expect(activeOption()?.textContent).toContain('Scarlet / Violet');
  });

  it('selects with the mouse and ignores disabled options', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const trigger = screen.getByRole('combobox');

    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: /Brilliant Diamond/ }));
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    await user.click(screen.getByRole('option', { name: /Custom odds/ }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('custom');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes when clicking outside and commits the active option on Tab', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <Harness onChange={onChange} />
        <button type="button">Next</button>
      </>,
    );
    const trigger = screen.getByRole('combobox');

    await user.click(trigger);
    await user.click(document.body);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(onChange).not.toHaveBeenCalled();

    trigger.focus();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await user.tab();
    expect(onChange).toHaveBeenCalledExactlyOnceWith('pla');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }));
  });

  it('holds the keyboard only while open, so in-app hotkeys never fire on type-ahead', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('combobox');

    expect(isKeyboardCaptured()).toBe(false);
    await user.click(trigger);
    expect(isKeyboardCaptured()).toBe(true);
    await user.keyboard('{Escape}');
    expect(isKeyboardCaptured()).toBe(false);
  });

  it('does nothing while disabled', async () => {
    const user = userEvent.setup();
    render(
      <Select options={GAMES} value="sv" onChange={() => undefined} disabled aria-label="Game" />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Game' });

    await user.click(trigger);
    expect(trigger).toHaveProperty('disabled', true);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
