import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router';

import { App } from './App';
import { DEMO_MODE } from './demo';
import './styles.css';

const Router = DEMO_MODE ? HashRouter : BrowserRouter;

createRoot(document.getElementById('root')!).render(
  <Router>
    <App />
  </Router>,
);
