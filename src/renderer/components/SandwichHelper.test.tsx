import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { oddsEngine, sandwichData } from '@renderer/lib/oddsData';
import { makeHunt, makeTarget, renderWithProviders } from '@renderer/test';
import SandwichHelper from './SandwichHelper';

describe('SandwichHelper view', () => {
  it("preselects the active hunt target's primary type and says so", async () => {
    const hunt = makeHunt({ target: makeTarget({ name: 'Ralts', types: ['psychic', 'fairy'] }) });
    const { user } = await renderWithProviders(<SandwichHelper />, {
      biolume: { hunts: [hunt], activeHuntId: hunt.id },
    });

    expect(screen.getByRole('button', { name: 'Psychic', pressed: true })).not.toBeNull();
    expect(screen.getByRole('status').textContent).toContain(
      'Psychic is the primary type of your target, Ralts. It is also Fairy-type',
    );

    const recipes = screen.getByRole('region', { name: 'Recipes' });
    const cards = within(recipes).getAllByRole('article');
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(within(card).getByText('Sparkling Power: Psychic')).not.toBeNull();
      expect(within(card).getByText(/^Minimum Herba$/)).not.toBeNull();
      expect(within(card).getByText('Solo')).not.toBeNull();
    }

    // Encounter-only recipes need no Herba Mystica.
    await user.click(screen.getByRole('radio', { name: /encounter only/i }));
    const encounter = within(recipes).getAllByRole('article');
    expect(within(encounter[0] as HTMLElement).getByText('No Herba needed')).not.toBeNull();
    expect(
      within(encounter[0] as HTMLElement).getByText('Encounter Power: Psychic'),
    ).not.toBeNull();

    // Every type at once.
    await user.click(screen.getByRole('button', { name: 'All types' }));
    expect(within(recipes).getAllByRole('article')).toHaveLength(
      sandwichData.recipes.filter((recipe) => recipe.sparklingLevel === 0).length,
    );
  });

  it('shows the summary, notes and Herba legend, and links into the odds engine', async () => {
    const hunt = makeHunt({ odds: oddsEngine.defaultSelection('sv', 'mass-outbreak') });
    const { user, mock } = await renderWithProviders(<SandwichHelper />, {
      biolume: { hunts: [hunt], activeHuntId: hunt.id },
    });

    expect(screen.getByText(sandwichData.summary)).not.toBeNull();
    expect(screen.getByText(/Meal Powers last 30 minutes/)).not.toBeNull();
    const legend = screen.getByRole('region', { name: 'Where Herba Mystica comes from' });
    for (const herba of sandwichData.herba) {
      expect(within(legend).getByText(herba.name)).not.toBeNull();
      expect(within(legend).getByText(herba.source)).not.toBeNull();
    }
    expect(screen.getByText(/Lv\. 3 gives 3 extra per Pokémon/)).not.toBeNull();

    await user.click(screen.getByRole('button', { name: `Set Lv. 3 on ${hunt.name}` }));
    expect(mock.api.hunts.update).toHaveBeenCalledWith(hunt.id, {
      odds: oddsEngine.updateSelection(hunt.odds, { inputs: { sparkling: 'lv3' } }),
    });
    // Once applied there is nothing left to offer.
    expect(screen.queryByRole('button', { name: /Set Lv\. 3 on/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'See it in Odds' }));
    expect(window.location.hash).toBe('#/odds');
  });

  it('asks for a type when there is no hunt to take one from', async () => {
    await renderWithProviders(<SandwichHelper />);
    expect(screen.getByRole('button', { name: 'All types', pressed: true })).not.toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/Pick the type of the Pokémon/);
    expect(screen.getAllByRole('article')).toHaveLength(
      sandwichData.recipes.filter((recipe) => recipe.sparklingLevel > 0).length,
    );
  });
});
