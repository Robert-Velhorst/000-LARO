'use strict';
(() => {
  const status = document.getElementById('connection');
  if (!status) return;
  let busy = false;
  async function checkConnection() {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const response = await fetch('./api/health', { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(5000) });
      const health = response.ok ? await response.json() : null;
      const message = health?.dbReady === true
        ? 'Deze lokale API is bereikbaar. Bronverbindingen en dossierkwaliteit zijn daarmee nog niet bevestigd.'
        : 'De lokale API is niet gereed. Controleer de installatie voordat je dossiers toevoegt.';
      if (status.textContent !== message) status.textContent = message;
    } catch {
      status.textContent = 'De lokale API is niet bereikbaar. Deze pagina is geen zelfstandige dossierinstallatie.';
    } finally {
      busy = false;
    }
  }
  void checkConnection();
  // Retry startup failures and refresh stale status without overlapping requests.
  setInterval(checkConnection, 15000);
  document.addEventListener('visibilitychange', checkConnection);
})();
