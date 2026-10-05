// Bridges the few native things the web UI can use inside the desktop app.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('encoreDesktop', {
  pickFolders: (): Promise<string[]> => ipcRenderer.invoke('encore:pick-folders'),
  openDataFolder: (): Promise<string> => ipcRenderer.invoke('encore:open-data-folder'),
  print: (): Promise<boolean> => ipcRenderer.invoke('encore:print'),
  savePdf: (name: string): Promise<string | null> => ipcRenderer.invoke('encore:save-pdf', name),
});
