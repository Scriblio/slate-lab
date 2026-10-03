import { createContext, useContext } from 'react';
import type { DjAction } from '../../shared/protocol.ts';
import type { DjView } from '../../shared/types.ts';
import type { AppSocket } from '../common/socket.ts';

export interface DjCtx {
  socket: AppSocket;
  view: DjView;
  /** Send an action; errors are shown as toasts. Resolves to the result or undefined. */
  act: <T = unknown>(action: DjAction, success?: string) => Promise<T | undefined>;
  /** Singer the song finder adds to. */
  target: string | null;
  setTarget: (id: string | null) => void;
  /** Request shown in the preview card. */
  preview: string | null;
  setPreview: (entryId: string | null) => void;
  /** Play id of the performance the finder is picking a replacement song for. */
  stageSwap: string | null;
  setStageSwap: (playId: string | null) => void;
  focusFinder: () => void;
}

export const DjContext = createContext<DjCtx | null>(null);

export function useDj(): DjCtx {
  const c = useContext(DjContext);
  if (!c) throw new Error('useDj outside DjContext');
  return c;
}
