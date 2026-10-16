import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDraftNumber } from './SettingRow';

/** A save whose completion the test controls, like an IPC round trip. */
function deferredWrite() {
  const resolvers: (() => void)[] = [];
  const write = vi.fn(
    (_value: number) => new Promise<void>((resolve) => void resolvers.push(resolve)),
  );
  return {
    write,
    finish: async () => {
      await act(async () => {
        resolvers.splice(0).forEach((resolve) => resolve());
        await Promise.resolve();
      });
    },
  };
}

describe('useDraftNumber', () => {
  it('saves only the value that is let go of, and shows it until the save is back', async () => {
    const { write, finish } = deferredWrite();
    const { result } = renderHook(() => useDraftNumber(1, write));

    act(() => result.current.onChange(1.1));
    act(() => result.current.onChange(1.25));
    expect(result.current.value).toBe(1.25);
    expect(write).not.toHaveBeenCalled();

    act(() => result.current.onCommit(1.25));
    expect(write).toHaveBeenCalledExactlyOnceWith(1.25);
    // Still the draft: the stored value (1) has not caught up yet.
    expect(result.current.value).toBe(1.25);

    await finish();
    expect(result.current.value).toBe(1);
  });

  it('saves every step when live, without saving the released value twice', async () => {
    const { write, finish } = deferredWrite();
    const { result } = renderHook(() => useDraftNumber(0.5, write, { live: true }));

    act(() => result.current.onChange(0.6));
    act(() => result.current.onChange(0.7));
    act(() => result.current.onCommit(0.7));
    expect(write.mock.calls).toEqual([[0.6], [0.7]]);
    // The draft waits for the save that is still in flight.
    expect(result.current.value).toBe(0.7);
    await finish();
    expect(result.current.value).toBe(0.5);
  });

  it('does not save when nothing changed (a blur without a drag)', async () => {
    const { write, finish } = deferredWrite();
    const { result } = renderHook(() => useDraftNumber(0.82, write));
    act(() => result.current.onCommit(0.82));
    await finish();
    expect(write).not.toHaveBeenCalled();
  });
});
