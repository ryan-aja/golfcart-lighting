import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { LightingProvider } from './hooks/LightingContext.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <LightingProvider>
      <App />
    </LightingProvider>
  </React.StrictMode>
);
