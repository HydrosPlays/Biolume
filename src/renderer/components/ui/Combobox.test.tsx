import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { isKeyboardCaptured } from '@renderer/hooks/useKeyboardCapture';
import '@renderer/test';
import { Combobox } from './Combobox';

interface Species {
  id: number;
  name: string;
}

const SPECIES: Species[] = [
  { id: 1, name: 'Bulbasaur' },
  { id: 4, name: 'Charmander' },
  { id: 5, name: 'Charmeleon' },
  { id: 6, name: 'Charizard' },
  { id: 7, name: 'Squirtle' },
];

function Harness({
  onSelect,
  disabledId,
}: {
  onSelect?: (species: Species) => void;
  disabledId?: number;
}) {
  const [query, setQuery] = useState('');
  const items = SPECIES.filter((species) =>
    species.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Combobox
      aria-label="Search species"
      placeholder="Search Pokémon"
      value={query}
      onValueChange={setQuery}
      items={query === '' ? [] : items}
      getKey={(species) => String(species.id)}
      getLabel={(species) => species.name}
      renderItem={(species) => <span>{species.name}</span>}
      isItemDisabled={(species) => species.id === disabledId}
      onSelect={(species) => {
        setQuery(species.name);
        onSelect?.(species);
      }}
    />
  );
}

function activeOption(): HTMLElement | null {
  const id = screen.getByRole('combobox').getAttribute('aria-activedescendant');
  return id ? document.getElementById(id) : null;
}

describe('Combobox', () => {
  it('stays closed until there is a query, then lists the results', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole<HTMLInputElement>('combobox', { name: 'Search species' });

    await user.click(input);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('listbox')).toBeNull();

    await user.type(input, 'char');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    const listbox = screen.getByRole('listbox');
    expect(input.getAttribute('aria-controls')).toBe(listbox.id);
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Charmander', 'Charmeleon', 'Charizard']);
    // The first result is highlighted and focus never leaves the input.
    expect(activeOption()?.textContent).toBe('Charmander');
    expect(document.activeElement).toBe(input);
  });

  it('navigates with wrapping arrows and selects with Enter', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    const input = screen.getByRole<HTMLInputElement>('combobox');

    await user.type(input, 'char');
    await user.keyboard('{ArrowDown}');
    expect(activeOption()?.textContent).toBe('Charmeleon');
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(activeOption()?.textContent).toBe('Charizard');
    await user.keyboard('{ArrowDown}');
    expect(activeOption()?.textContent).toBe('Charmander');

    await user.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ id: 5, name: 'Charmeleon' });
    expect(input.value).toBe('Charmeleon');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it('selects with a click and skips disabled results', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} disabledId={4} />);
    const input = screen.getByRole('combobox');

    await user.type(input, 'char');
    // Charmander is disabled, so the highlight starts on the next result.
    expect(activeOption()?.textContent).toBe('Charmeleon');
    await user.click(screen.getByRole('option', { name: 'Charmander' }));
    expect(onSelect).not.toHaveBeenCalled();

    await user.click(screen.getByRole('option', { name: 'Charizard' }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith({ id: 6, name: 'Charizard' });
  });

  it('closes on the first Escape and clears the text on the second', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole<HTMLInputElement>('combobox');

    await user.type(input, 'squ');
    expect(screen.getByRole('listbox')).not.toBeNull();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(input.value).toBe('squ');

    await user.keyboard('{Escape}');
    expect(input.value).toBe('');
  });

  it('shows an empty message and reopens when typing again', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole('combobox');

    await user.type(input, 'zzz');
    expect(screen.getByText('No matches')).not.toBeNull();
    expect(screen.queryAllByRole('option')).toHaveLength(0);

    await user.clear(input);
    await user.type(input, 'bulb');
    expect(screen.getByRole('option', { name: 'Bulbasaur' })).not.toBeNull();
  });

  it('holds the keyboard while its results are open and offers a clear button', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole<HTMLInputElement>('combobox');

    expect(isKeyboardCaptured()).toBe(false);
    await user.type(input, 'ch');
    expect(isKeyboardCaptured()).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(input.value).toBe('');
    expect(isKeyboardCaptured()).toBe(false);
    expect(document.activeElement).toBe(input);
  });
});
