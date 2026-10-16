import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Bug, RotateCcw } from 'lucide-react';
import { Button, EmptyState } from '@renderer/components/ui';
import styles from './AppShell.module.css';

export interface ViewErrorBoundaryProps {
  /** Human name of what is being rendered, e.g. "Odds" — used in the fallback copy. */
  name: string;
  /** Render nothing instead of the fallback (for non-essential hosts such as the phase dialog). */
  silent?: boolean;
  children: ReactNode;
}

interface ViewErrorBoundaryState {
  error: Error | null;
}

/**
 * Contains a crash to the view it happened in: the shell, the other views and
 * — crucially — hotkey counting keep working. Remount it (`key={view}`) to
 * clear the error when navigating away and back.
 */
export class ViewErrorBoundary extends Component<ViewErrorBoundaryProps, ViewErrorBoundaryState> {
  override state: ViewErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ViewErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[biolume] "${this.props.name}" crashed`, error, info.componentStack);
  }

  private readonly retry = (): void => {
    this.setState({ error: null });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    if (this.props.silent) return null;

    return (
      <div className={styles.fallback} role="alert">
        <EmptyState
          tone="danger"
          icon={<Bug />}
          title={`${this.props.name} ran into a problem`}
          description="Your hunts and counts are safe — they live in the main process. Try loading this view again."
          action={
            <Button variant="secondary" leadingIcon={<RotateCcw />} onClick={this.retry}>
              Try again
            </Button>
          }
        />
        <pre className={styles.fallbackDetails}>{error.message || error.name}</pre>
      </div>
    );
  }
}
