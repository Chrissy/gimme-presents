import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import type { Gift, GiftInput, ListResponse, MeResponse } from '../shared/api';
import { errorMessage, request, RequestError, write } from './api';

const blankGift: GiftInput = { name: '', url: '', image: '', price: '' };
const accessNote = 'Keep this browser’s cookies to keep editing your lists.';

function ChristmasTitle({ children, action }: { children: string; action?: ReactNode }) {
  return <div className="title-wrapper"><h1 className="list-title">
    <span className="modified-title">{Array.from(children).map((letter, index) =>
      <span key={index} aria-hidden="true">{letter}</span>)}<span className="sr-only">{children}</span></span>
    {action}
  </h1></div>;
}

function ErrorNotice({ message, children }: { message: string; children?: ReactNode }) {
  return <div className="notice error-notice" role="alert"><p>{message}</p>{children}</div>;
}

function HomePage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    document.title = 'GimmePresents';
    const controller = new AbortController();
    setLoadError('');
    request<MeResponse>('/api/me', { signal: controller.signal }).then(setMe).catch((reason: unknown) => {
      if (!controller.signal.aborted) setLoadError(errorMessage(reason));
    });
    return () => controller.abort();
  }, [loadAttempt]);

  async function createList(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const create = () => write<ListResponse>('/api/lists', 'POST', { name });
      // Share a lock across tabs so the first response's ownership cookie is
      // present before another tab creates its list in this browser.
      const result = typeof navigator.locks?.request === 'function'
        ? await navigator.locks.request('gimme-presents-create-list', create)
        : await create();
      navigate(`/${encodeURIComponent(result.list.slug)}`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return <main className="create-list-page">
    <ChristmasTitle>Gimme some freakin’ presents!</ChristmasTitle>
    <h2 className="sub-title">Make a gift list for your lame family by typing in the thing below.</h2>
    <form className="new_list" onSubmit={createList}>
      <label className="sr-only" htmlFor="list-name">List name</label>
      <input id="list-name" name="name" value={name} onChange={(event) => setName(event.target.value)}
        placeholder="Name your stupid list" required maxLength={120} disabled={busy} autoComplete="off" />
      <div><button className="text-button" disabled={busy}>{busy ? 'Creating…' : 'create my list!'}</button></div>
      {error && <ErrorNotice message={error} />}
    </form>
    <p className="access-note home-access-note">{accessNote}</p>
    {loadError && <ErrorNotice message={`Couldn’t load your saved lists. ${loadError}`}>
      <button type="button" className="text-button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Try again</button>
    </ErrorNotice>}
    {!me && !loadError && <p className="status-message" role="status">Checking this browser for your lists…</p>}
    {me && me.lists.length > 0 && <section className="previous-lists" aria-labelledby="previous-lists-heading">
      <h2 className="sub-title" id="previous-lists-heading">Also, here are some dumb lists you've made before:</h2>
      <ol>{me.lists.map((list) => <li className="list-element" key={list.id}>
        <Link to={`/${encodeURIComponent(list.slug)}`}>{list.name} ({new Date(list.createdAt).getFullYear()})</Link>
      </li>)}</ol>
    </section>}
  </main>;
}

function giftInput(gift: Gift): GiftInput {
  return { name: gift.name, url: gift.url, image: gift.image, price: gift.priceCents === null ? '' : (gift.priceCents / 100).toFixed(2) };
}

function GiftForm({ value, onChange, onSubmit, busy, editing, onCancel, children }: {
  value: GiftInput;
  onChange: (value: GiftInput) => void;
  onSubmit: () => void;
  busy: boolean;
  editing?: boolean;
  onCancel?: () => void;
  children?: ReactNode;
}) {
  const prefix = editing ? 'edit-gift' : 'new-gift';
  return <form className={editing ? 'edit_gift' : 'new_gift'} onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <h3 className="add-message">{editing ? 'Edit your sweet present!' : 'Add a sweet present!'}</h3>
    <fieldset disabled={busy}>
      <label className="sr-only" htmlFor={`${prefix}-name`}>Gift name</label>
      <input id={`${prefix}-name`} name="name" value={value.name} placeholder="Name" required maxLength={200}
        onChange={(event) => onChange({ ...value, name: event.target.value })} />
      <label className="sr-only" htmlFor={`${prefix}-url`}>Gift URL</label>
      <input id={`${prefix}-url`} name="url" type="url" value={value.url} placeholder="URL" maxLength={2048}
        onChange={(event) => onChange({ ...value, url: event.target.value })} />
      <label className="sr-only" htmlFor={`${prefix}-image`}>Image URL</label>
      <input id={`${prefix}-image`} name="image" type="url" value={value.image} placeholder="Link to a photo" maxLength={2048}
        onChange={(event) => onChange({ ...value, image: event.target.value })} />
      <label className="sr-only" htmlFor={`${prefix}-price`}>Price in dollars</label>
      <input id={`${prefix}-price`} name="price" type="text" inputMode="decimal" value={value.price} placeholder="Price"
        onChange={(event) => onChange({ ...value, price: event.target.value })} />
      <div className="form-actions">
        <button className="text-button" type="submit">{busy ? 'Saving…' : editing ? 'update my gift!' : 'create my gift!'}</button>
        {onCancel && <button className="text-button" type="button" onClick={onCancel}>cancel</button>}
      </div>
    </fieldset>
    {children}
  </form>;
}

function safeRemoteUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function GiftImage({ gift }: { gift: Gift }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [gift.image]);
  if (!gift.image) return null;
  const imageUrl = safeRemoteUrl(gift.image);
  if (failed || !imageUrl) return <p className="image-unavailable">Photo unavailable</p>;
  return <img src={imageUrl} alt={gift.name} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function ListPage({ editTitle = false }: { editTitle?: boolean }) {
  const { slug, id } = useParams();
  const identifier = slug ?? id ?? '';
  const navigate = useNavigate();
  const [data, setData] = useState<ListResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [newGift, setNewGift] = useState<GiftInput>({ ...blankGift });
  const [editing, setEditing] = useState<{ id: number; value: GiftInput } | null>(null);
  const [listName, setListName] = useState('');
  const mutationLock = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoadError('');
    setNotFound(false);
    const path = editTitle ? `/api/lists/by-id/${encodeURIComponent(identifier)}` : `/api/lists/${encodeURIComponent(identifier)}`;
    request<ListResponse>(path, { signal: controller.signal }).then((result) => {
      if (!editTitle && identifier !== result.list.slug) {
        navigate(`/${encodeURIComponent(result.list.slug)}`, { replace: true });
        return;
      }
      setData(result);
      setListName(result.list.name);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setNotFound(reason instanceof RequestError && reason.status === 404);
      setLoadError(errorMessage(reason));
    });
    return () => controller.abort();
  }, [identifier, editTitle, loadAttempt, navigate]);

  useEffect(() => {
    document.title = data ? `${data.list.name} · GimmePresents` : 'GimmePresents';
  }, [data?.list.name]);

  async function mutate(operation: () => Promise<ListResponse>, success: string): Promise<boolean> {
    if (mutationLock.current || conflict) return false;
    mutationLock.current = true;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const result = await operation();
      setData(result);
      setStatus(success);
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      if (reason instanceof RequestError && reason.status === 409) setConflict(true);
      return false;
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }

  async function reloadLatest() {
    if (!data || mutationLock.current) return;
    mutationLock.current = true;
    setBusy(true);
    try {
      const result = await request<ListResponse>(`/api/lists/by-id/${data.list.id}`);
      setData(result);
      setConflict(false);
      setError('');
      setStatus('Latest list loaded. Your unsaved changes are still here. Review them, then save again.');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }

  if (loadError && !data) return <main className="message-page">
    <ChristmasTitle>{notFound ? 'No presents here!' : 'Well, this is awkward.'}</ChristmasTitle>
    <ErrorNotice message={notFound ? 'That list could not be found.' : loadError}>
      {!notFound && <button className="text-button" type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Try again</button>}
    </ErrorNotice><Link to="/">Make a list of your own</Link>
  </main>;
  if (!data) return <main className="message-page"><p role="status">Loading your presents…</p></main>;

  const list = data.list;
  const disabled = busy || conflict;
  const mutationPath = `/api/lists/${list.id}`;
  const common = { revision: list.revision };

  async function addGift() {
    if (await mutate(() => write<ListResponse>(`${mutationPath}/gifts`, 'POST', { ...newGift, ...common }), 'Gift added!')) {
      setNewGift({ ...blankGift });
    }
  }

  async function saveGift() {
    if (!editing) return;
    if (await mutate(() => write<ListResponse>(`${mutationPath}/gifts/${editing.id}`, 'PUT', { ...editing.value, ...common }), 'Gift updated!')) {
      setEditing(null);
    }
  }

  async function deleteGift(gift: Gift) {
    if (!window.confirm(`Delete “${gift.name}” from your list?`)) return;
    if (await mutate(() => write<ListResponse>(`${mutationPath}/gifts/${gift.id}`, 'DELETE', common), 'Gift deleted.')) {
      if (editing?.id === gift.id) setEditing(null);
    }
  }

  async function moveGift(index: number, direction: -1 | 1) {
    const giftIds = data!.gifts.map((gift) => gift.id);
    const destination = index + direction;
    if (destination < 0 || destination >= giftIds.length) return;
    [giftIds[index], giftIds[destination]] = [giftIds[destination], giftIds[index]];
    await mutate(() => write<ListResponse>(`${mutationPath}/reorder`, 'POST', { giftIds, ...common }), 'Gift moved.');
  }

  async function saveTitle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await mutate(() => write<ListResponse>(mutationPath, 'PUT', { name: listName, ...common }), 'List updated!')) {
      navigate(`/${encodeURIComponent(list.slug)}`);
    }
  }

  async function deleteList() {
    if (mutationLock.current || conflict || !window.confirm(`Delete “${list.name}” and all its gifts? This cannot be undone.`)) return;
    mutationLock.current = true;
    setBusy(true);
    setError('');
    try {
      await write<{ ok: true }>(mutationPath, 'DELETE', common);
      navigate('/');
    } catch (reason) {
      setError(errorMessage(reason));
      if (reason instanceof RequestError && reason.status === 409) setConflict(true);
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }

  async function copyLink() {
    const url = new URL(`/${encodeURIComponent(list.slug)}`, window.location.origin).href;
    try {
      await navigator.clipboard.writeText(url);
      setStatus('Public link copied! Anyone with this link can view your list.');
    } catch {
      setStatus(`Copy this public link: ${url}`);
    }
  }

  const notices = <>
    {error && <ErrorNotice message={error} />}
    {conflict && <div className="notice conflict-notice" role="alert">
      <p>This list changed in another tab. Load the latest version before trying again. Your unsaved fields will be kept.</p>
      <button className="text-button" type="button" disabled={busy} onClick={reloadLatest}>{busy ? 'Loading…' : 'Load latest list'}</button>
    </div>}
    {status && <p className="notice status-notice" role="status">{status}</p>}
  </>;

  const editingForm = editing && <GiftForm value={editing.value} onChange={(value) => setEditing({ ...editing, value })}
    onSubmit={saveGift} busy={disabled} editing onCancel={() => setEditing(null)} />;

  return <main className={`list-page ${data.canEdit ? 'editable-list' : 'public-list'}`}>
    <ChristmasTitle action={data.canEdit && !editTitle
      ? <Link className="edit-list-title edit-link" to={`/edit/${list.id}`} aria-label="Edit list name">edit</Link> : undefined}>{list.name}</ChristmasTitle>
    <nav className="list-navigation" aria-label="List navigation">
      <Link to="/">{data.canEdit ? 'My lists / make another' : 'Make your own list'}</Link>
      <button className="text-button" type="button" onClick={copyLink}>Copy public link</button>
    </nav>
    {data.canEdit && <p className="access-note list-access-note">{accessNote}</p>}
    {!data.canEdit && editTitle && <ErrorNotice message="This browser does not have editing access to this list." />}
    <div className="list-notices">{notices}</div>
    {editTitle && data.canEdit ? <form className="edit_list" onSubmit={saveTitle}>
      <label className="sr-only" htmlFor="edit-list-name">List name</label>
      <input id="edit-list-name" value={listName} onChange={(event) => setListName(event.target.value)} placeholder="Name your stupid list"
        required maxLength={120} disabled={disabled} />
      <div className="form-actions">
        <button className="text-button" disabled={disabled}>{busy ? 'Saving…' : 'update my list!'}</button>
        <button className="text-button danger-button" type="button" disabled={disabled} onClick={deleteList}>delete</button>
        <Link to={`/${encodeURIComponent(list.slug)}`}>cancel</Link>
      </div>
    </form> : <>
      {data.canEdit && <aside className="add-gift-panel" aria-label="Add a gift">
        <GiftForm value={newGift} onChange={setNewGift} onSubmit={addGift} busy={disabled} />
      </aside>}
      {editing && !data.gifts.some((gift) => gift.id === editing.id) && <section className="missing-gift-draft">
        <ErrorNotice message="This gift is no longer in the list. Your unsaved fields are below; copy anything you need before canceling." />
        {editingForm}
      </section>}
      <div className="gifts">
        {data.gifts.length === 0 && <p className="empty-list">{data.canEdit ? 'No presents yet. Add a sweet present to get started!' : 'No presents on this list yet.'}</p>}
        {data.gifts.map((gift, index) => <article className="gift" key={gift.id} aria-label={gift.name}>
          <GiftImage gift={gift} />
          <div className="gift-name">{safeRemoteUrl(gift.url) ? <a href={safeRemoteUrl(gift.url)} target="_blank" rel="noopener noreferrer">{gift.name}</a> : gift.name}</div>
          {gift.priceCents !== null && <span className="price">{new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(gift.priceCents / 100)}</span>}
          {data.canEdit && <div className="gift-controls">
            <button type="button" className="text-button" disabled={disabled} aria-label={`Edit ${gift.name}`}
              onClick={() => setEditing({ id: gift.id, value: giftInput(gift) })}>edit</button>
            <button type="button" className="text-button" disabled={disabled || index === 0} aria-label={`Move ${gift.name} up`}
              onClick={() => moveGift(index, -1)}>↑ up</button>
            <button type="button" className="text-button" disabled={disabled || index === data.gifts.length - 1} aria-label={`Move ${gift.name} down`}
              onClick={() => moveGift(index, 1)}>↓ down</button>
            <button type="button" className="text-button danger-button" disabled={disabled} aria-label={`Delete ${gift.name}`}
              onClick={() => deleteGift(gift)}>delete</button>
          </div>}
          {editing?.id === gift.id && <div className="edit-gift-container">{editingForm}</div>}
        </article>)}
      </div>
    </>}
  </main>;
}

function RoutedList({ editTitle = false }: { editTitle?: boolean }) {
  const { slug, id } = useParams();
  return <ListPage key={`${editTitle ? 'edit' : 'view'}-${slug ?? id}`} editTitle={editTitle} />;
}

function NotFoundPage() {
  return <main className="message-page"><ChristmasTitle>No presents here!</ChristmasTitle>
    <p>That page could not be found.</p><Link to="/">Make a list of your own</Link>
  </main>;
}

export function App() {
  return <Routes>
    <Route path="/" element={<HomePage />} />
    <Route path="/edit/:id" element={<RoutedList editTitle />} />
    <Route path="/:slug" element={<RoutedList />} />
    <Route path="*" element={<NotFoundPage />} />
  </Routes>;
}
