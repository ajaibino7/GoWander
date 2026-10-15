// #/account — who you're signed in as, sign out, and backup (download / import trips.json).
import { useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../app/AppData';
import { importFile, signOutAndReload } from '../app/actions';
import { APP_VERSION, RELEASE } from '../app/version';
import { BackLink } from '../components/Hero';
import { Page } from '../components/Page';
import * as cloud from '../lib/cloud';
import * as store from '../lib/store';
import { SignInCard } from './Home';

export function AccountPage() {
  const { user, myTrips } = useAppData();
  const navigate = useNavigate();
  const file = useRef<HTMLInputElement>(null);

  return (
    <Page
      viewId="view-settings"
      hero={{ title: 'Account', sub: user ? user.email : 'Not signed in', nav: <BackLink /> }}
      foot={cloud.emulatorMode ? 'Using local Firebase emulators.' : 'Signed in with Google via Firebase Authentication.'}
    >
      {!user ? <SignInCard /> : (
        <>
          <section className="ed-card">
            <div className="who">
              {user.photo
                ? <img className="avatar-lg" src={user.photo} alt="" referrerPolicy="no-referrer" />
                : <span className="avatar avatar-lg">{(user.email[0] || '?').toUpperCase()}</span>}
              <div><strong>{user.name}</strong><div className="fine">{user.email}</div></div>
            </div>
            <p className="fine">Collaborators add you by this email address.</p>
            <div><button className="btn ghost" type="button" onClick={signOutAndReload}>Sign out</button></div>
          </section>
          <section className="ed-card">
            <h2 className="sec-h">Backup</h2>
            <p className="fine">Download every trip you're a member of as a <code>trips.json</code> file, or import one. Imported trips are added to your account with only you as a member.</p>
            <div className="home-actions">
              <button className="btn ghost" type="button" onClick={() => store.downloadJson('trips.json', { version: 1, trips: myTrips.map((x) => x.trip) })}>Download my trips</button>
              <button className="btn ghost" type="button" onClick={() => file.current?.click()}>Import file</button>
            </div>
          </section>
          <p className="fine app-version" title={`Build ${APP_VERSION}`}>GoWander V{RELEASE}</p>
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f && (await importFile(user, f))) navigate('/');
          }} />
        </>
      )}
    </Page>
  );
}
