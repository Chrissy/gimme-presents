import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import type { Gift, GiftInput, ListResponse } from '../shared/api';
import { errorMessage, request, RequestError, write } from './api';

const blankGift: GiftInput = { name: '', url: '', image: '', price: '' };

function ChristmasTitle({ children, action, wrapped = true }: { children: string; action?: ReactNode; wrapped?: boolean }) {
  const title = <h1 className="list-title" aria-label={children}>
    <span className="modified-title" aria-hidden="true">{Array.from(children).map((letter, index) =>
      <span key={index}>{letter}</span>)}</span>{action && <> {action}</>}
  </h1>;
  return wrapped ? <div className="title-wrapper">{title}</div> : title;
}

function ErrorNotice({ message, children }: { message: string; children?: ReactNode }) {
  return <div role="alert"><p>{message}</p>{children}</div>;
}

function SubmitLink({ children, disabled }: { children: string; disabled: boolean }) {
  return <><input type="submit" value={children} className="hidden" disabled={disabled} />
    <a href="#" className="fake-submit" aria-disabled={disabled || undefined} onClick={(event) => {
      event.preventDefault();
      if (!disabled) event.currentTarget.closest('form')?.requestSubmit();
    }}>{children}</a></>;
}

function HomePage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
      window.scrollTo(0, 0);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return <main className="create-list-page">
    <ChristmasTitle wrapped={false}>Gimme some freakin’ presents!</ChristmasTitle>
    <h2 className="sub-title">Make a gift list for your lame family by typing in the thing below.</h2>
    <form className="new_list" onSubmit={createList}>
      <div className="form_block primary">
        <input type="text" aria-label="List name" name="name" value={name} onChange={(event) => setName(event.target.value)}
          placeholder="Name your stupid list" /><br />
        <SubmitLink disabled={busy}>create my list!</SubmitLink>
      </div>
      {error && <ErrorNotice message={error} />}
    </form>
  </main>;
}

function giftInput(gift: Gift): GiftInput {
  return { name: gift.name, url: gift.url, image: gift.image, price: gift.priceCents === null ? '' : String(gift.priceCents / 100) };
}

function GiftForm({ value, onChange, onSubmit, busy, editing, children }: {
  value: GiftInput;
  onChange: (value: GiftInput) => void;
  onSubmit: () => void;
  busy: boolean;
  editing?: boolean;
  children?: ReactNode;
}) {
  return <form className={editing ? 'edit_gift' : 'new_gift'} onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    <h3 className="add-message">Add a sweet present!</h3>
    <div className="form_block primary">
      <input type="text" aria-label="Gift name" name="name" value={value.name} placeholder="Name"
        onChange={(event) => onChange({ ...value, name: event.target.value })} />{' '}
      <input type="text" aria-label="Gift URL" name="url" value={value.url} placeholder="URL"
        onChange={(event) => onChange({ ...value, url: event.target.value })} />{' '}
      <input type="text" aria-label="Image URL" name="image" value={value.image} placeholder="Link to a photo"
        onChange={(event) => onChange({ ...value, image: event.target.value })} />{' '}
      <input type="text" aria-label="Price in dollars" name="price" value={value.price} placeholder="Price"
        onChange={(event) => onChange({ ...value, price: event.target.value })} /><br />
      <SubmitLink disabled={busy}>{editing ? 'update my gift!' : 'create my gift!'}</SubmitLink>
      {children}
    </div>
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

function ListPage({ editTitle = false }: { editTitle?: boolean }) {
  const { slug, id } = useParams();
  const identifier = slug ?? id ?? '';
  const navigate = useNavigate();
  const [data, setData] = useState<ListResponse | null>(null);
  const [loadError, setLoadError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [newGift, setNewGift] = useState<GiftInput>({ ...blankGift });
  const [editingId, setEditingId] = useState<number | null>(null);
  const [giftDrafts, setGiftDrafts] = useState<Record<number, GiftInput>>({});
  const [listName, setListName] = useState('');
  const mutationLock = useRef(false);
  const editorRef = useRef<HTMLDivElement>(null);

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
      if (editTitle && !result.canEdit) {
        navigate('/', { replace: true });
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
    if (editingId === null) return;
    const closeEditor = (event: MouseEvent) => {
      if (event.target instanceof Node && !editorRef.current?.contains(event.target)) setEditingId(null);
    };
    document.addEventListener('click', closeEditor);
    return () => document.removeEventListener('click', closeEditor);
  }, [editingId]);

  async function mutate(operation: () => Promise<ListResponse>): Promise<boolean> {
    if (mutationLock.current || conflict) return false;
    mutationLock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await operation();
      setData(result);
      setEditingId(null);
      setGiftDrafts({});
      setNewGift({ ...blankGift });
      window.scrollTo(0, 0);
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
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }

  if (loadError && !data) return <main>
    <ErrorNotice message={notFound ? 'That list could not be found.' : loadError}>
      {!notFound && <button type="button" onClick={() => setLoadAttempt((attempt) => attempt + 1)}>Try again</button>}
    </ErrorNotice><Link to="/">Make a list of your own</Link>
  </main>;
  if (!data) return null;

  const list = data.list;
  const disabled = busy || conflict;
  const mutationPath = `/api/lists/${list.id}`;
  const common = { revision: list.revision };

  async function addGift() {
    await mutate(() => write<ListResponse>(`${mutationPath}/gifts`, 'POST', { ...newGift, ...common }));
  }

  async function saveGift() {
    if (editingId === null) return;
    await mutate(() => write<ListResponse>(`${mutationPath}/gifts/${editingId}`, 'PUT', { ...giftDrafts[editingId], ...common }));
  }

  async function deleteGift(gift: Gift) {
    await mutate(() => write<ListResponse>(`${mutationPath}/gifts/${gift.id}`, 'DELETE', common));
  }

  async function moveGift(index: number, direction: -1 | 1) {
    const giftIds = data!.gifts.map((gift) => gift.id);
    const destination = index + direction;
    if (destination < 0 || destination >= giftIds.length) {
      setEditingId(null);
      setGiftDrafts({});
      setNewGift({ ...blankGift });
      window.scrollTo(0, 0);
      return;
    }
    [giftIds[index], giftIds[destination]] = [giftIds[destination], giftIds[index]];
    await mutate(() => write<ListResponse>(`${mutationPath}/reorder`, 'POST', { giftIds, ...common }));
  }

  async function saveTitle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await mutate(() => write<ListResponse>(mutationPath, 'PUT', { name: listName, ...common }))) {
      navigate(`/${encodeURIComponent(list.slug)}`);
    }
  }

  async function deleteList() {
    if (mutationLock.current || conflict || !window.confirm('are you sure?!')) return;
    mutationLock.current = true;
    setBusy(true);
    setError('');
    try {
      await write<{ ok: true }>(mutationPath, 'DELETE', common);
      navigate('/');
      window.scrollTo(0, 0);
    } catch (reason) {
      setError(errorMessage(reason));
      if (reason instanceof RequestError && reason.status === 409) setConflict(true);
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }

  const notices = <>
    {error && <ErrorNotice message={error} />}
    {conflict && <div role="alert">
      <p>This list changed in another tab. Load the latest version before trying again. Your unsaved fields will be kept.</p>
      <button type="button" disabled={busy} onClick={reloadLatest}>Load latest list</button>
    </div>}
  </>;

  if (editTitle) return <main>
    {notices}
    {data.canEdit ? <form className="edit_list" onSubmit={saveTitle}>
      <div className="form_block primary">
        <input type="text" aria-label="List name" value={listName} onChange={(event) => setListName(event.target.value)} placeholder="Name your stupid list" /><br />
        <SubmitLink disabled={disabled}>update my list!</SubmitLink>{' '}
        <a href="#" style={{ color: 'red' }} aria-disabled={disabled || undefined} onClick={(event) => { event.preventDefault(); if (!disabled) void deleteList(); }}>delete</a>
      </div>
    </form> : <ErrorNotice message="This browser does not have editing access to this list." />}
  </main>;

  return <main className="list-page">
    <ChristmasTitle action={data.canEdit
      ? <Link className="edit-list-title edit-link" to={`/edit/${list.id}`} aria-label="Edit list name" /> : undefined}>{list.name}</ChristmasTitle>
    {data.canEdit && <aside aria-label="Add a gift">
      <GiftForm value={newGift} onChange={setNewGift} onSubmit={addGift} busy={disabled} />
    </aside>}
    {notices}
    <div className="gifts">
      {data.gifts.map((gift, index) => <article className="gift" key={gift.id} aria-label={gift.name}>
        <img src={safeRemoteUrl(gift.image)} alt={gift.image ? gift.name : ''} /><br />
        <a href={safeRemoteUrl(gift.url) ?? ''}>{gift.name}</a><br />
        <span className="price">{gift.priceCents !== null ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(gift.priceCents / 100) : ''}</span>
        {data.canEdit && <> <div className="controls">
          <a href="#" className="toggle-edit-controls edit-link" aria-label={`Edit ${gift.name}`} onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setGiftDrafts((drafts) => ({ ...drafts, [gift.id]: drafts[gift.id] ?? giftInput(gift) }));
            setEditingId(gift.id);
          }}>edit</a>
          <div className={`edit-gift-container hidden${editingId === gift.id ? ' active' : ''}`} ref={editingId === gift.id ? editorRef : undefined}>
            {editingId === gift.id && <GiftForm value={giftDrafts[gift.id]} onChange={(value) => setGiftDrafts((drafts) => ({ ...drafts, [gift.id]: value }))}
              onSubmit={saveGift} busy={disabled} editing>
              {' '}<a href="#" aria-label={`Delete ${gift.name}`} aria-disabled={disabled || undefined} onClick={(event) => { event.preventDefault(); if (!disabled) void deleteGift(gift); }}>delete</a>
              {' '}<a href="#" aria-label={`Move ${gift.name} up`} aria-disabled={disabled || undefined} onClick={(event) => { event.preventDefault(); if (!disabled) void moveGift(index, -1); }}>[+]</a>
              {' '}<a href="#" aria-label={`Move ${gift.name} down`} aria-disabled={disabled || undefined} onClick={(event) => { event.preventDefault(); if (!disabled) void moveGift(index, 1); }}>[-]</a>
            </GiftForm>}
          </div>
        </div></>}
      </article>)}
    </div>
  </main>;
}

function RoutedList({ editTitle = false }: { editTitle?: boolean }) {
  const { slug, id } = useParams();
  return <ListPage key={`${editTitle ? 'edit' : 'view'}-${slug ?? id}`} editTitle={editTitle} />;
}

export function App() {
  return <Routes>
    <Route path="/" element={<HomePage />} />
    <Route path="/edit/:id" element={<RoutedList editTitle />} />
    <Route path="/:slug" element={<RoutedList />} />
    <Route path="*" element={<main><p>That page could not be found.</p><Link to="/">Make a list of your own</Link></main>} />
  </Routes>;
}
