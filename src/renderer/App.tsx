import { PokeApiProvider } from '@renderer/api/provider';
import { AppShell } from '@renderer/components/layout/AppShell';

/**
 * The main window. The PokeAPI query cache wraps the whole shell so every
 * view (and the phase dialog) shares one persisted cache.
 */
export default function App() {
  return (
    <PokeApiProvider>
      <AppShell />
    </PokeApiProvider>
  );
}
