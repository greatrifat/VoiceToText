import type { DesktopApi } from './types';

declare global {
  interface Window {
    voiceDesktop: DesktopApi;
  }
}

export {};
