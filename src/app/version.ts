// RELEASE is the version people see; bump it by hand when shipping. APP_VERSION is the build
// hash written into index.html by scripts/postbuild.mjs and is what the update check compares.
import { toast } from '../lib/toast';

export const RELEASE = '1.0.1';
export const APP_VERSION = document.querySelector<HTMLMetaElement>('meta[name="app-version"]')?.content || 'dev';

let updateShown = false;
async function checkForUpdate(): Promise<void> {
  if (APP_VERSION === 'dev' || updateShown) return;
  try {
    const res = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
    const { version } = (await res.json()) as { version?: string };
    if (version && version !== APP_VERSION) {
      updateShown = true;
      toast('A new version of GoWander is available.', 'info', { duration: 0, action: { label: 'Reload', onClick: () => location.reload() } });
    }
  } catch { /* offline — try again later */ }
}

/** Tell people when a newer GoWander has been deployed. */
export function watchForUpdates(): void {
  setTimeout(checkForUpdate, 5000);
  setInterval(checkForUpdate, 30 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
}
