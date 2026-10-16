import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useUiStore } from '@renderer/store/uiStore';
import '@renderer/test';
import { TypeBadge, typeColor } from './Badge';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { Kbd } from './Kbd';
import { ProgressRing, StatBar } from './Meters';
import { SegmentedControl } from './SegmentedControl';
import { Sprite } from './Sprite';
import { TabPanel, Tabs } from './Tabs';
import { ToastRegion } from './Toast';
import { Checkbox, Toggle } from './Toggle';
import { Tooltip } from './Tooltip';
import { toast } from './index';

describe('toast + ToastRegion', () => {
  it('announces toasts, runs their action and dismisses them', async () => {
    const user = userEvent.setup();
    const undo = vi.fn();
    render(<ToastRegion />);

    act(() => {
      toast.success('Phase logged', {
        description: 'Zigzagoon after 120',
        action: { label: 'Undo', onClick: undo },
      });
      toast.error('Export failed');
    });

    expect(screen.getByRole('region', { name: 'Notifications' })).not.toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Phase logged');
    expect(screen.getByRole('alert').textContent).toContain('Export failed');

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Phase logged')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(useUiStore.getState().toasts).toHaveLength(0);
  });

  it('auto-dismisses after its duration, pausing while hovered', () => {
    vi.useFakeTimers();
    try {
      render(<ToastRegion />);
      act(() => {
        toast.info('Saved', { duration: 1000 });
      });
      const card = screen.getByRole('status');

      act(() => vi.advanceTimersByTime(600));
      fireEvent.mouseEnter(card);
      act(() => vi.advanceTimersByTime(5000));
      expect(screen.queryByText('Saved')).not.toBeNull();

      fireEvent.mouseLeave(card);
      act(() => vi.advanceTimersByTime(350));
      expect(screen.queryByText('Saved')).not.toBeNull();
      act(() => vi.advanceTimersByTime(100));
      expect(screen.queryByText('Saved')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps sticky toasts until dismissed', () => {
    vi.useFakeTimers();
    try {
      render(<ToastRegion />);
      act(() => {
        toast.info('Identify the phase', { duration: 0 });
      });
      act(() => vi.advanceTimersByTime(60_000));
      expect(screen.queryByText('Identify the phase')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Sprite', () => {
  it('walks the fallback list on errors and ends on a named silhouette', () => {
    render(
      <Sprite
        src={['https://example.test/shiny.png', null, 'https://example.test/default.png']}
        alt="Ralts"
      />,
    );

    let image = screen.getByRole<HTMLImageElement>('img', { name: 'Ralts' });
    expect(image.src).toBe('https://example.test/shiny.png');

    fireEvent.error(image);
    image = screen.getByRole<HTMLImageElement>('img', { name: 'Ralts' });
    expect(image.src).toBe('https://example.test/default.png');

    fireEvent.error(image);
    const silhouette = screen.getByRole('img', { name: 'Ralts' });
    expect(silhouette.tagName.toLowerCase()).toBe('svg');
  });

  it('starts over when the sources change and shows a silhouette for no source', () => {
    const { rerender, container } = render(<Sprite src="https://example.test/a.png" alt="A" />);
    fireEvent.error(screen.getByRole('img', { name: 'A' }));
    expect(container.querySelector('img')).toBeNull();

    rerender(<Sprite src="https://example.test/b.png" alt="B" />);
    expect(screen.getByRole<HTMLImageElement>('img', { name: 'B' }).src).toBe(
      'https://example.test/b.png',
    );

    rerender(<Sprite src={null} alt="" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('small controls', () => {
  it('Button ignores clicks while loading and defaults to type=button', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
    expect(button.type).toBe('button');

    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);

    rerender(
      <Button onClick={onClick} loading>
        Save
      </Button>,
    );
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('IconButton exposes its label, pressed state and a tooltip on keyboard focus', async () => {
    const user = userEvent.setup();
    render(
      <IconButton label="Keep window on top" pressed shortcut="CommandOrControl+T">
        <svg />
      </IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Keep window on top' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();

    await user.tab();
    expect(document.activeElement).toBe(button);
    const tooltip = screen.getByRole('tooltip', { hidden: true });
    expect(tooltip.textContent).toContain('Keep window on top');
    expect(tooltip.textContent).toContain('Ctrl');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
  });

  it('Tooltip describes its trigger after the hover delay and hides on leave', () => {
    vi.useFakeTimers();
    try {
      render(
        <Tooltip content="Counts even while your game has focus" delay={300}>
          <button type="button">Global</button>
        </Tooltip>,
      );
      const trigger = screen.getByRole('button', { name: 'Global' });

      fireEvent.mouseEnter(trigger);
      act(() => vi.advanceTimersByTime(299));
      expect(screen.queryByRole('tooltip')).toBeNull();
      act(() => vi.advanceTimersByTime(1));
      const tooltip = screen.getByRole('tooltip');
      expect(trigger.getAttribute('aria-describedby')).toBe(tooltip.id);

      fireEvent.mouseLeave(trigger);
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(trigger.getAttribute('aria-describedby')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('Toggle and Checkbox report the next state', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onCheck = vi.fn();
    render(
      <>
        <Toggle
          checked={false}
          onChange={onToggle}
          label="Global hotkeys"
          description="Count while unfocused"
        />
        <Checkbox checked onChange={onCheck} label="Show sprite" />
      </>,
    );

    const toggle = screen.getByRole('switch', {
      name: 'Global hotkeys',
      description: 'Count while unfocused',
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await user.click(toggle);
    expect(onToggle).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByText('Global hotkeys'));
    expect(onToggle).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('checkbox', { name: 'Show sprite' }));
    expect(onCheck).toHaveBeenLastCalledWith(false);
  });

  it('SegmentedControl is a radiogroup with roving focus and arrow keys', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SegmentedControl
        aria-label="Format"
        value="json"
        onChange={onChange}
        options={[
          { value: 'json', label: 'JSON' },
          { value: 'csv', label: 'CSV' },
          { value: 'xml', label: 'XML', disabled: true },
        ]}
      />,
    );

    expect(screen.getByRole('radiogroup', { name: 'Format' })).not.toBeNull();
    const json = screen.getByRole('radio', { name: 'JSON' });
    expect(json.getAttribute('aria-checked')).toBe('true');
    expect(json.tabIndex).toBe(0);
    expect(screen.getByRole('radio', { name: 'CSV' }).tabIndex).toBe(-1);

    json.focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('csv');
    // Value is controlled (still "json"): the next arrow skips the disabled XML and wraps.
    await user.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenLastCalledWith('csv');
  });

  it('Tabs link tabs to panels and move with the arrow keys', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <Tabs
          id="log"
          aria-label="Log sections"
          value="sessions"
          onChange={onChange}
          items={[
            { id: 'sessions', label: 'Sessions' },
            { id: 'phases', label: 'Phases', badge: 3 },
          ]}
        />
        <TabPanel tabsId="log" tabId="sessions" active>
          Session list
        </TabPanel>
        <TabPanel tabsId="log" tabId="phases" active={false}>
          Phase list
        </TabPanel>
      </>,
    );

    const sessions = screen.getByRole('tab', { name: 'Sessions' });
    expect(sessions.getAttribute('aria-selected')).toBe('true');
    const panel = screen.getByRole('tabpanel', { name: 'Sessions' });
    expect(sessions.getAttribute('aria-controls')).toBe(panel.id);
    expect(screen.queryByText('Phase list')).toBeNull();

    sessions.focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('phases');
    await user.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('phases');
  });

  it('Kbd, TypeBadge, StatBar and ProgressRing expose readable semantics', () => {
    render(
      <>
        <Kbd accelerator="CommandOrControl+Shift+B" />
        <TypeBadge type="fire" />
        <TypeBadge type="dragon" size="dot" />
        <StatBar label="Speed" value={300} max={255} />
        <ProgressRing value={0.634} aria-label="Chance so far" aria-valuetext="63 %" />
      </>,
    );

    expect(screen.getByText('Shift').tagName).toBe('KBD');
    expect(screen.getByText('B').tagName).toBe('KBD');
    expect(screen.getByText('Fire')).not.toBeNull();
    expect(screen.getByRole('img', { name: 'Dragon type' })).not.toBeNull();
    // Values beyond the range are clamped for assistive tech.
    expect(screen.getByRole('meter', { name: 'Speed' }).getAttribute('aria-valuenow')).toBe('255');
    const ring = screen.getByRole('progressbar', { name: 'Chance so far' });
    expect(ring.getAttribute('aria-valuenow')).toBe('63');
    expect(ring.getAttribute('aria-valuetext')).toBe('63 %');

    expect(typeColor('Fire')).toBe('var(--type-fire)');
    expect(typeColor('shadow')).toBe('var(--ink-300)');
  });
});
