import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import App from './App';
import { ThemeProvider } from './components/Theme';
import { ToastProvider } from './components/Toast';
import { AuthProvider } from './auth/AuthProvider';
import { installBfcacheGuard } from './auth/clientState';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000,
      refetchOnWindowFocus: false,
      retry: (count, error) => !['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'NOT_VERIFIED'].includes(error?.code) && count < 1,
    },
  },
});

installBfcacheGuard();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ThemeProvider>
          <ToastProvider>
            <AuthProvider>
              <App />
            </AuthProvider>
          </ToastProvider>
        </ThemeProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
