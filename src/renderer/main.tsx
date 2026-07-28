import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.js';
import { TooltipProvider } from './components/ui/tooltip.js';
import { applyTheme, watchSystemTheme } from './lib/utils.js';
import './index.css';

applyTheme();
watchSystemTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The API is a local SQLite database over IPC. Failures are real failures,
      // not flaky networks, so retrying is mostly a way to hide bugs.
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
    mutations: { retry: 0 },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200} skipDelayDuration={300}>
        <App />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
