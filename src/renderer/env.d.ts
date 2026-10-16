/// <reference types="vite/client" />
import type { BiolumeApi } from '@shared/ipc';

declare global {
  interface Window {
    /** Exposed by `src/main/preload.ts` through `contextBridge`. */
    biolume: BiolumeApi;
  }
}

export {};
