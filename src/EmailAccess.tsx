import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import type { MeResponse } from '../shared/api';
import { errorMessage, request, write } from './api';

function requestKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function EmailRequestForm({ name, claim = false, returnListId, onBack }: {
  name?: string; claim?: boolean; returnListId?: number; onBack?: () => void;
}) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [sentTo, setSentTo] = useState('');
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const key = useRef(requestKey());
  useEffect(() => {
    if (!sent) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [sent]);
  async function send(event?: FormEvent, resend = false) {
    event?.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await write<{ delivery: 'sent' | 'pending' }>('/api/auth/request', 'POST', {
        email, name, claim, returnListId, clientKey: key.current, resend,
        replace: !!sentTo && sentTo !== email.trim(),
      });
      setSentTo(email.trim()); setPending(result.delivery === 'pending'); setSent(true);
      setRetryAt(Date.now() + 60_000); setNow(Date.now());
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  return <section className="email-panel" aria-label={sent ? 'Check your email' : 'Email verification'}>
    {sent ? <>
      <h2 tabIndex={-1}>Check your email</h2>
      <p>{pending ? 'Your email is queued for delivery to' : 'We sent a link to'} <strong>{sentTo}</strong>.</p>
      <p>Open the link and press Continue to {name ? 'create your list' : 'restore editing access'}. The link works for 30 minutes.</p>
      <p className="email-hint">Use the browser where you want to edit your lists. You can close this tab after opening the email.</p>
      <div className="email-actions">
        <button className="text-button" disabled={busy || seconds > 0} onClick={() => void send(undefined, true)}>
          {seconds > 0 ? `Resend in ${seconds}s` : 'Resend email'}
        </button>
        <button className="text-button" disabled={busy} onClick={() => { setSent(false); setError(''); }}>Change email</button>
      </div>
    </> : <form onSubmit={send} aria-busy={busy}>
      <h2>{claim ? 'Save access to your lists' : name ? 'Save access to your list' : 'Get back to your lists'}</h2>
      {name && <p className="pending-list-name">{name}</p>}
      <label htmlFor="access-email">Your email</label>
      <input id="access-email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false}
        maxLength={254} required autoFocus value={email} onChange={event => setEmail(event.target.value)} disabled={busy} />
      <p>Use this email to recover access to your lists at any time.</p>
      {claim && <p>We’ll connect the lists you can edit in this browser to your verified email.</p>}
      <button className="email-submit" disabled={busy}>{busy ? 'Sending…' : 'Email me a link'}</button>
      {onBack && <button type="button" className="text-button" disabled={busy} onClick={onBack}>Back to list name</button>}
    </form>}
    {error && <div className="form-notice" role="alert"><p>{error}</p></div>}
  </section>;
}

export function RecoveryPage() {
  const [params] = useSearchParams();
  const id = Number(params.get('list'));
  return <main className="access-page">
    <Link to="/">GimmePresents</Link>
    <EmailRequestForm claim={params.get('claim') === '1'} returnListId={Number.isSafeInteger(id) && id > 0 ? id : undefined} />
    <p className="access-footer"><Link to="/">Make a new list</Link></p>
  </main>;
}

export function ConfirmationPage() {
  const location = useLocation();
  const token = new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
  return <ConfirmLink key={token} token={token} />;
}
function ConfirmLink({ token }: { token: string }) {
  const navigate = useNavigate();
  const [details, setDetails] = useState<{ email: string; name: string | null; claim: boolean } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    request<typeof details>('/api/auth/inspect', { method: 'POST', body: JSON.stringify({ token }), signal: controller.signal })
      .then(setDetails).catch(reason => { if (!controller.signal.aborted) setError(errorMessage(reason)); });
    return () => controller.abort();
  }, [token]);
  async function confirm(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await write<{ path: string }>('/api/auth/confirm', 'POST', { token });
      navigate(result.path, { replace: true }); window.scrollTo(0, 0);
    } catch (reason) { setError(errorMessage(reason)); setBusy(false); }
  }
  return <main className="access-page">
    <Link to="/">GimmePresents</Link>
    <section className="email-panel">
      <h1>{details?.name ? 'Your list is almost ready' : 'Restore editing access'}</h1>
      {details ? <form onSubmit={confirm} aria-busy={busy}>
        {details.name && <p className="pending-list-name">{details.name}</p>}
        <p>Continue as <strong>{details.email}</strong>.</p>
        {details.claim && <p>This will save the lists from your original browser to this email.</p>}
        <button className="email-submit" disabled={busy}>{busy ? 'Opening your list…' : 'Continue'}</button>
        <p className="email-hint">You’ll be able to edit your lists in this browser.</p>
      </form> : !error && <p role="status">Checking your link…</p>}
      {error && <div className="form-notice" role="alert"><p>{error}</p></div>}
      <p><Link to="/auth/recover">Get a fresh access link</Link></p>
    </section>
  </main>;
}

export function ExistingAccessNotice({ listId, canEdit }: { listId: number; canEdit: boolean }) {
  const [me, setMe] = useState<MeResponse | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    request<MeResponse>('/api/me', { signal: controller.signal }).then(setMe).catch(() => {});
    return () => controller.abort();
  }, []);
  if (!canEdit) return <p className="access-footer"><Link to={`/auth/recover?list=${listId}`}>Is this your list? Restore editing access</Link></p>;
  if (!me || me.verified) return null;
  return <p className="access-footer">Keep editing here, or <Link to={`/auth/recover?claim=1&list=${listId}`}>save your lists to your email</Link> to recover access and add images.</p>;
}
