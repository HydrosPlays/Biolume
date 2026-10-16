import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Where popovers mount. `document.body` by default; a Modal provides its own
 * layer so dropdowns and tooltips opened inside it stack above the dialog
 * instead of underneath the scrim.
 */
export const PortalContext = createContext<HTMLElement | null>(null);

/** Renders children into the nearest portal layer (the body, or the enclosing Modal's layer). */
export function Portal({ children }: { children: ReactNode }) {
  const container = useContext(PortalContext);
  return createPortal(children, container ?? document.body);
}
