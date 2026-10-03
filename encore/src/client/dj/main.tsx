import { createRoot } from 'react-dom/client';
import '../common/base.css';
import './dj.css';
import { ToastProvider } from '../common/ui.tsx';
import { DjApp } from './DjApp.tsx';

createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <DjApp />
  </ToastProvider>,
);
