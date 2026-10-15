// Opening a trip you're not in: offer to join. Firebase only lets it through if the owner has
// turned on "Anyone with the link can join" (view-only if the owner chose that for link joiners).
import { useState } from 'react';
import { useAppData } from '../../app/AppData';
import { switchAccount } from '../../app/actions';
import { BackLink } from '../../components/Hero';
import { Page } from '../../components/Page';
import * as cloud from '../../lib/cloud';
import { toast } from '../../lib/toast';

export function JoinTrip({ id, onJoined }: { id: string; onJoined: () => void }) {
  const { user } = useAppData();
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState('');
  if (!user) return null;
  return (
    <Page viewId="view-import" hero={{ eyebrow: 'Trip invite', title: 'Join this trip', nav: <BackLink /> }}>
      <section className="ed-card">
        <h2 className="sec-h">You've been invited to a trip</h2>
        <p className="fine">Join as <strong>{user.email}</strong> to see the plan, follow it live and edit it with everyone else.</p>
        <div className="home-actions">
          <button className="btn" type="button" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              await cloud.joinTrip(user, id);
              toast('You joined the trip', 'ok');
              onJoined();
            } catch (err) {
              setBusy(false);
              setHelp(`${(err as Error).message} They can also add ${user.email} under Members.`);
            }
          }}>Join trip</button>
          <button className="btn ghost" type="button" onClick={switchAccount}>Use a different Google account</button>
        </div>
        {help ? <p className="fine">{help}</p> : null}
      </section>
    </Page>
  );
}
