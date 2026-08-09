import React from 'react';
import ReactDOM from 'react-dom/client';
import { Toaster } from 'sonner';
import DashboardApp from './DashboardApp';
import App from './App';
import { TrpcProvider } from './providers/TrpcProvider';
import { I18nProvider } from './contexts/I18nContext';
import './index.css';

const params = new URLSearchParams(window.location.search);
const isScannerMode = params.get('mode') === 'scanner' || window.location.hash.includes('mode=scanner');

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <TrpcProvider>
        {isScannerMode ? <App /> : <DashboardApp />}
        <Toaster
        richColors
        position="top-right"
        theme="dark"
        closeButton
        expand={false}
        visibleToasts={3}
        duration={4500}
        toastOptions={{
          style: {
            fontSize: "14px",
            fontWeight: 500,
          },
          classNames: {
            toast:
              "border border-border/60 shadow-lg backdrop-blur-md text-foreground",
            title: "font-semibold",
            description: "opacity-90",
          },
        }}
        />
      </TrpcProvider>
    </I18nProvider>
  </React.StrictMode>
);
