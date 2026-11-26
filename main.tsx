import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './geosnap_zim_geo_pomona_civic_reporting_app.tsx';
import './styles.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Could not find the #root element.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
