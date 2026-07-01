import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { ThemeProvider } from './components/theme-provider';
import { AppearanceProvider } from './components/appearance-provider';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider defaultTheme="system">
        <AppearanceProvider>
          <App />
        </AppearanceProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
);
