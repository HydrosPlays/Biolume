/**
 * Test utilities for renderer tests.
 *
 *   import { installMockBiolume, makeHunt, renderWithProviders } from '@renderer/test';
 *
 * Importing this module also installs the shared test environment (`./setup`):
 * DOM cleanup, the React act environment, and a reset of stores, keyboard
 * capture, audio and the fake bridge after every test.
 */
import './setup';

export {
  applySettingsPatch,
  makeHunt,
  makePhase,
  makeSession,
  makeSettings,
  makeTarget,
  resetFactorySequence,
  TEST_TIMESTAMP,
} from './factories';
export {
  installMockBiolume,
  uninstallMockBiolume,
  type MockBiolume,
  type MockBiolumeOptions,
  type MockedBiolumeApi,
} from './mockBiolume';
export {
  createTestQueryClient,
  renderWithProviders,
  type RenderWithProvidersOptions,
  type RenderWithProvidersResult,
} from './render';
