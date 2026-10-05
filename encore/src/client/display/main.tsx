import { createRoot } from 'react-dom/client';
import '../common/base.css';
import './display.css';
import { DisplayApp } from './DisplayApp.tsx';

createRoot(document.getElementById('root')!).render(<DisplayApp />);
