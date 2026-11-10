import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@excalidraw/excalidraw/index.css';

import App from './App.jsx';
import { takeSession } from './host.js';
import { texts } from './i18n.js';
import './app.css';

const start = takeSession();
const root = document.getElementById('root');
if (start) {
  document.documentElement.lang = start.lang;
  document.documentElement.dataset.theme = start.theme;
  createRoot(root).render(
    <StrictMode>
      <App start={start} />
    </StrictMode>,
  );
} else {
  // Opened by its address, not by the plugin's page: nothing to show.
  const lang = navigator.language?.startsWith('ru') ? 'ru' : 'en';
  root.className = 'rc-empty';
  root.textContent = texts(lang).noSession;
}
