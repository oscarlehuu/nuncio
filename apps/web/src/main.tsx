import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthGate } from './components/auth-gate';
import { ThemeProvider } from './components/theme-provider';
import { AppearanceProvider } from './components/appearance-provider';
import { AccentProvider } from './components/accent-provider';
import { API_BASE, installApiBaseFetch } from './lib/api-base';
import './index.css';

// In hub mode the app is served under /m/<machine>/; route its /api calls there
// and match the router basename before anything renders.
installApiBaseFetch();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={API_BASE || undefined}>
      <ThemeProvider defaultTheme="system">
        <AccentProvider>
          <AppearanceProvider>
            <AuthGate>
              <App />
            </AuthGate>
          </AppearanceProvider>
        </AccentProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
);
