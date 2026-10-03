// Native helpers the desktop app provides (see src/desktop/preload.cts).
// Undefined when Encore runs in an ordinary browser.

export interface EncoreDesktop {
  pickFolders(): Promise<string[]>;
  openDataFolder(): Promise<string>;
}

declare global {
  interface Window {
    encoreDesktop?: EncoreDesktop;
  }
}

export const desktop: EncoreDesktop | undefined = typeof window === 'undefined' ? undefined : window.encoreDesktop;
