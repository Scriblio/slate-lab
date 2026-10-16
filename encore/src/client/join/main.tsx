import { createRoot } from 'react-dom/client';
import '../common/base.css';
import './join.css';
import { ToastProvider } from '../common/ui.tsx';
import { JoinApp } from './JoinApp.tsx';

createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <JoinApp />
  </ToastProvider>,
);
