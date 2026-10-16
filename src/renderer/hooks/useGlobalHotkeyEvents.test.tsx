import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CounterSource } from '@shared/types';
import { initStore } from '@renderer/store/appStore';
import { useUiStore } from '@renderer/store/uiStore';
import { installMockBiolume, makeHunt, makePhase } from '@renderer/test';
import { useGlobalHotkeyEvents } from './useGlobalHotkeyEvents';

function toastById(id: string) {
  return useUiStore.getState().toasts.find((entry) => entry.id === id);
}

/** Sets up a hunt and pushes a quick-logged phase from `source`, the way main announces it. */
async function logPhaseFrom(source: CounterSource) {
  const hunt = makeHunt({ name: 'Shiny Ralts', count: 40 });
  const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
  await initStore();
  renderHook(() => useGlobalHotkeyEvents());

  const phase = makePhase({ id: 'phase-sd', speciesId: null, speciesName: '' });
  mock.emit({
    type: 'hunt-changed',
    hunt: { ...hunt, count: 0, priorCount: hunt.priorCount + hunt.count, phases: [phase] },
    change: { kind: 'phase-logged', delta: -hunt.count, source, phaseId: phase.id },
  });
  return { hunt, phase };
}

describe('useGlobalHotkeyEvents', () => {
  it("offers to identify a phase the Stream Deck's Log Phase key quick-logged", async () => {
    const { hunt, phase } = await logPhaseFrom('streamdeck');
    const offer = toastById(`phase-logged:${phase.id}`);
    expect(offer).toMatchObject({ title: 'Phase logged', duration: 0 });
    expect(offer?.action?.label).toBe('Identify');

    act(() => offer?.action?.onClick());
    expect(useUiStore.getState().phaseDialog).toMatchObject({
      huntId: hunt.id,
      phaseId: phase.id,
    });
  });

  it('leaves phases logged in the app itself alone', async () => {
    const { phase } = await logPhaseFrom('ui');
    expect(toastById(`phase-logged:${phase.id}`)).toBeUndefined();
  });

  it('still offers it for a global Log Phase hotkey', async () => {
    const hunt = makeHunt();
    const mock = installMockBiolume({ hunts: [hunt], activeHuntId: hunt.id });
    await initStore();
    renderHook(() => useGlobalHotkeyEvents());

    mock.fireHotkeyAction({
      action: 'logPhase',
      accelerator: 'F15',
      huntId: hunt.id,
      phaseId: 'phase-hotkey',
    });
    expect(toastById('phase-logged:phase-hotkey')?.title).toBe('Phase logged');
  });
});
