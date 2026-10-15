// #/members/:id — who's in the trip and their access. The owner invites people (by link or by
// email), sets each person to "Can edit" or "View only", and removes people; others can leave.
import { useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppData } from '../app/AppData';
import { useReveal } from '../app/motion';
import { useTripWatch } from '../app/useTripWatch';
import { useTripProfiles } from '../app/names';
import { shareCopy, shareOrCopy } from '../app/actions';
import { BackLink } from '../components/Hero';
import { NicknameCard } from '../components/NicknameCard';
import { Page, PageLoading } from '../components/Page';
import * as cloud from '../lib/cloud';
import { ask, toast } from '../lib/toast';
import type { Role } from '../lib/types';
import { HomePage } from './Home';
import { JoinTrip } from './trip/JoinTrip';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_MEMBERS = 20;

function RoleSelect({ value, label, disabled, onChange, name }: { value: Role; label: string; disabled?: boolean; onChange?: (r: Role) => void; name?: string }) {
  return (
    <select className="role-sel" aria-label={label} name={name} value={value} disabled={disabled} onChange={(e) => onChange?.(e.target.value as Role)}>
      <option value="edit">Can edit</option>
      <option value="view">View only</option>
    </select>
  );
}

export function MembersPage() {
  const { id = '' } = useParams();
  const { user, authReady } = useAppData();
  const navigate = useNavigate();
  const { entry, denied, retry } = useTripWatch(id, user);
  const profiles = useTripProfiles(user ? id : null);
  const [busy, setBusy] = useState<string | null>(null); // which control is saving
  const [email, setEmail] = useState('');
  const [newRole, setNewRole] = useState<Role>('edit');
  const ref = useRef<HTMLDivElement>(null);
  useReveal(ref, '.members > li', !!entry);

  if (!authReady) return <PageLoading viewId="view-members" eyebrow="Trip members" back={<BackLink to={`/trip/${encodeURIComponent(id)}`} label="Back to trip" />} tripId={id} />;
  if (!user) return <HomePage message="Sign in to manage trip members." />;
  if (denied) return <JoinTrip id={id} onJoined={retry} />;
  if (!entry) return <PageLoading viewId="view-members" eyebrow="Trip members" back={<BackLink to={`/trip/${encodeURIComponent(id)}`} label="Back to trip" />} tripId={id} />;

  const { trip, meta } = entry;
  const owner = meta.ownerUid === user.uid;
  const invite = `${location.origin}${location.pathname}#/trip/${encodeURIComponent(trip.id)}`;
  const members = [meta.ownerEmail, ...meta.memberEmails.filter((m) => m !== meta.ownerEmail)];
  const full = meta.memberEmails.length >= MAX_MEMBERS;
  const fail = (err: unknown) => toast((err as Error).message, 'bad');

  const setRole = async (m: string, role: Role) => {
    setBusy(`role:${m}`);
    try {
      await cloud.setRole(user, trip.id, m, role);
      toast(`${m} ${role === 'view' ? 'can now only view' : 'can now edit'} the plan`, 'ok');
    } catch (err) { fail(err); }
    setBusy(null);
  };

  return (
    <Page
      viewId="view-members"
      hero={{
        eyebrow: 'Trip members',
        title: trip.title,
        sub: `${meta.memberEmails.length} member${meta.memberEmails.length === 1 ? '' : 's'}`,
        nav: <BackLink to={`/trip/${encodeURIComponent(trip.id)}`} label="Back to trip" />,
        tripId: trip.id,
      }}
      foot="Only members can open this trip. Access is enforced by Firebase security rules."
    >
      <div ref={ref} style={{ display: 'contents' }}>
        <NicknameCard tripId={trip.id} user={user} current={profiles.get(user.email)?.nickname || ''} />
        <section className="ed-card">
          <h2 className="sec-h">Invite people</h2>
          {owner ? (
            <label className="chk big">
              <input type="checkbox" checked={meta.linkJoin} disabled={busy === 'link'} onChange={async (e) => {
                const on = e.target.checked;
                setBusy('link');
                try {
                  await cloud.setLinkJoin(user, trip.id, on);
                  toast(on ? 'Anyone with the link can now join' : 'Link joining turned off. Only people you add by email can join.', 'ok');
                } catch (err) { fail(err); }
                setBusy(null);
              }} /> Anyone with the link can join
            </label>
          ) : (
            <p className="fine"><strong>{meta.linkJoin ? 'Anyone with the link can join.' : 'Only people the owner adds by email can join.'}</strong></p>
          )}
          <p className="fine">
            {meta.linkJoin
              ? <>Send this link to friends. They open it, sign in with Google and tap <em>Join trip</em>. No need to type their email.{full ? <> <strong>This trip is full ({MAX_MEMBERS} members).</strong></> : null}</>
              : owner ? 'Turn this on to let people join with just the link. Otherwise, add their Google email below first, then send them the link.' : 'Send this link to people the owner has added by email.'}
          </p>
          {meta.linkJoin ? (owner ? (
            <label className="fld role-line"><span>People who join with the link</span>
              <RoleSelect value={meta.linkRole} label="People who join with the link" disabled={busy === 'linkRole'} onChange={async (role) => {
                setBusy('linkRole');
                try {
                  await cloud.setLinkRole(user, trip.id, role);
                  toast(`People who join with the link ${role === 'view' ? 'can only view' : 'can edit'} the plan`, 'ok');
                } catch (err) { fail(err); }
                setBusy(null);
              }} />
            </label>
          ) : (
            <p className="fine">People who join with the link <strong>{meta.linkRole === 'view' ? 'can only view' : 'can edit'}</strong> the plan.</p>
          )) : null}
          <div className="invite-row">
            <input className="invite-url" readOnly value={invite} aria-label="Invite link" />
            <button className="btn" type="button" onClick={() => shareOrCopy(invite, `Join my trip “${trip.title}”`, 'Invite link copied')}>{'share' in navigator ? 'Share' : 'Copy'}</button>
          </div>
        </section>

        <section className="ed-card">
          <h2 className="sec-h">Who can see and edit this trip</h2>
          <ul className="members">
            {members.map((m) => {
              const viewer = meta.viewerEmails.includes(m);
              return (
                <li key={m}>
                  <span className="avatar">{((profiles.get(m)?.nickname || m)[0] || '?').toUpperCase()}</span>
                  <span className="m-email">
                    {profiles.get(m)?.nickname ? <strong className="m-nick">{profiles.get(m)?.nickname}</strong> : null}
                    <span className={profiles.get(m)?.nickname ? 'muted small' : ''}>{m}</span>
                    {m === user.email ? <> <span className="muted">(you)</span></> : null}
                  </span>
                  {m === meta.ownerEmail ? <span className="badge pub">Owner</span>
                    : owner ? <RoleSelect value={viewer ? 'view' : 'edit'} label={`Access for ${m}`} disabled={busy === `role:${m}`} onChange={(r) => setRole(m, r)} />
                    : <span className={`badge ${viewer ? 'view' : 'local'}`}>{viewer ? 'View only' : 'Can edit'}</span>}
                  {owner && m !== meta.ownerEmail ? (
                    <button className="icon-btn" type="button" title={`Remove ${m}`} aria-label={`Remove ${m}`} onClick={async () => {
                      if (!(await ask(`Remove ${m} from this trip?`, { detail: 'They lose access straight away.', ok: 'Remove', danger: true }))) return;
                      try { await cloud.setMembers(user, trip.id, meta.memberEmails.filter((x) => x !== m), meta.viewerEmails); toast('Removed', 'ok'); } catch (err) { fail(err); }
                    }}>✕</button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {owner ? (
            <>
              <form className="add-member" noValidate onSubmit={async (e) => {
                e.preventDefault();
                const addr = email.trim().toLowerCase();
                if (!EMAIL.test(addr)) { toast('Enter a valid email address.', 'bad'); return; }
                if (meta.memberEmails.includes(addr)) { toast('They\'re already a member.', 'bad'); return; }
                const viewOnly = newRole === 'view';
                try {
                  await cloud.setMembers(user, trip.id, [...meta.memberEmails, addr], viewOnly ? [...meta.viewerEmails, addr] : meta.viewerEmails);
                  setEmail('');
                  toast(`Added ${addr}${viewOnly ? ' (view only)' : ''}. Now send them the invite link.`, 'ok');
                } catch (err) { fail(err); }
              }}>
                <input type="email" placeholder="Or add by email: friend@gmail.com" autoComplete="off" aria-label="Collaborator's Google email" disabled={full} value={email} onChange={(e) => setEmail(e.target.value)} />
                <RoleSelect value={newRole} label="Their access" name="role" disabled={full} onChange={setNewRole} />
                <button className="btn ghost" type="submit" disabled={full}>Add</button>
              </form>
              <p className="fine">Use the email of their <strong>Google account</strong>. <strong>Can edit</strong>: change the plan. <strong>View only</strong>: see everything, and still tick stops, the checklist and expenses, but not change the plan. Only you can add or remove people, change access or delete the trip.</p>
            </>
          ) : (
            <p className="fine">{meta.ownerEmail} owns this trip and manages who's in it.{meta.viewerEmails.includes(user.email) ? <> You have <strong>view-only</strong> access: you can tick stops, use the checklist and log expenses, but not change the plan.</> : null}</p>
          )}
        </section>

        <section className="ed-card">
          <h2 className="sec-h">Send a copy instead</h2>
          <p className="fine">Gives someone their own separate copy of the plan. They can't see your future changes, and you can't see theirs.</p>
          <div><button className="btn ghost" type="button" onClick={() => shareCopy(trip)}>Send a copy</button></div>
        </section>

        {owner ? null : (
          <section className="ed-card">
            <h2 className="sec-h">Leave this trip</h2>
            <p className="fine">It disappears from your list. The owner can add you back later.</p>
            <div><button className="btn ghost danger" type="button" onClick={async () => {
              if (!(await ask('Leave this trip?', { detail: 'You\'ll lose access until the owner adds you again.', ok: 'Leave trip', danger: true }))) return;
              try { await cloud.leaveTrip(user, trip.id); toast('You left the trip', 'ok'); navigate('/', { replace: true }); } catch (err) { fail(err); }
            }}>Leave trip</button></div>
          </section>
        )}
      </div>
    </Page>
  );
}
