// #/account — who you're signed in as, your name in GoWander, sign out, and backup
// (download / import trips.json).
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppData } from '../app/AppData';
import { importFile, signOutAndReload } from '../app/actions';
import { APP_VERSION, RELEASE } from '../app/version';
import { BackLink } from '../components/Hero';
import { Page } from '../components/Page';
import * as cloud from '../lib/cloud';
import * as store from '../lib/store';
import { firstName } from '../lib/greeting';
import { toast } from '../lib/toast';
import type { User } from '../lib/types';
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
          <NameCard user={user} />
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

// Your name in GoWander: used to greet you on the home screen (and suggested as your name on
// new trips). Saved to your account, so all your devices see it.
function NameCard({ user }: { user: User }) {
  const [edit, setEdit] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const shown = user.name.includes('@') ? '' : user.name;
  const start = () => { setValue(shown); setEdit(true); };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = value.trim().replace(/\s+/g, ' ');
    setSaving(true);
    try {
      await cloud.setMyName(n);
      setEdit(false);
      toast(n ? `Nice to meet you, ${n.split(' ')[0]}!` : 'Back to the name from your Google account', 'ok');
    } catch (err) { toast((err as Error).message, 'bad'); }
    setSaving(false);
  };
  return (
    <section className="ed-card name-card">
      <div className="sec-row">
        <h2 className="sec-h">Your name</h2>
        {edit ? null : <button className="link-btn" type="button" onClick={start}>{shown ? 'Change' : 'Add your name'}</button>}
      </div>
      {edit ? (
        <form className="nick-form" noValidate onSubmit={save}>
          <span className="nick-av" aria-hidden="true">{(value.trim()[0] || user.email[0] || '?').toUpperCase()}</span>
          <input autoFocus maxLength={40} placeholder="e.g. Ajai Bino" autoComplete="name" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Your name" />
          <button className="btn ghost" type="button" onClick={() => setEdit(false)}>Cancel</button>
          <button className="btn" type="submit" disabled={saving || value.trim() === shown}>{saving ? 'Saving…' : 'Save'}</button>
        </form>
      ) : (
        <p className="name-show"><strong>{shown || firstName(user)}</strong>{shown ? null : <span className="muted small"> (from your email)</span>}</p>
      )}
      <p className="fine">GoWander greets you by this name. Your name on each trip is set on that trip’s Members page; leave this empty to use your Google name.</p>
    </section>
  );
}
