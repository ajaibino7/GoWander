// Entry point: page-zoom blocking, the service worker, the update check, then the app.
// (The stylesheets are linked from index.html, so even the first paint is styled.)
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { watchForUpdates } from './app/version';

/* ============================================================
   No page zoom. The viewport meta covers Android; iOS Safari ignores it, so block its pinch
   gestures too, and Ctrl + wheel / Ctrl +/-/0 on desktop. The map handles its own zoom first,
   so it still zooms.
   ============================================================ */
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1 && !(e.target as Element | null)?.closest?.('#map')) e.preventDefault();
}, { passive: false });
document.addEventListener('wheel', (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && ['+', '=', '-', '_', '0'].includes(e.key)) e.preventDefault();
});
// iOS Safari only plays :active styles (button press feedback) once a touch listener exists.
document.addEventListener('touchstart', () => {}, { passive: true });

watchForUpdates();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // updateViaCache: 'none' makes the browser always re-check sw.js itself, ignoring HTTP caching.
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' })
    .then((reg) => document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); }))
    .catch(() => {});
}

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');
// The static first paint inside #root is replaced by the app's first render.
createRoot(root).render(<StrictMode><App /></StrictMode>);
