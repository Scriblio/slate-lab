// Native helpers the desktop app provides (see src/desktop/preload.cts).
// Undefined when Encore runs in an ordinary browser.

export interface EncoreDesktop {
  pickFolders(): Promise<string[]>;
  openDataFolder(): Promise<string>;
  /** Opens the system print window for this page; resolves once it closes. Missing in older builds. */
  print?(): Promise<boolean>;
}

declare global {
  interface Window {
    encoreDesktop?: EncoreDesktop;
  }
}

export const desktop: EncoreDesktop | undefined = typeof window === 'undefined' ? undefined : window.encoreDesktop;
