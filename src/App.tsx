import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import type { Gift, GiftInput, GiftSuggestion, ListResponse, MeResponse } from '../shared/api';
import { errorMessage, request, RequestError, write } from './api';
import { EmailRequestForm, RecoveryPage, ConfirmationPage, ExistingAccessNotice } from './EmailAccess';
import { AllListsPage } from './AllListsPage';
import { ImagePicker, type GiftDraft } from './ImagePicker';
import { GIFT_FORM_WAIT_MS } from '../shared/gift-suggestion-limits';
import { giftImageUrl, safeRemoteUrl } from './urls';

const GiftRail = lazy(() => import('./GiftRail'));

const blankGift: GiftInput = { name: '', url: '', image: '', price: '' };

function ChristmasTitle({ children, action, wrapped = true }: { children: string; action?: ReactNode; wrapped?: boolean }) {
  const title = <h1 className="list-title" aria-label={children}>
    <span className="modified-title" aria-hidden="true">{Array.from(children).map((letter, index) =>
      <span key={index}>{letter}</span>)}</span>{action && <> {action}</>}
  </h1>;
  return wrapped ? <div className="title-wrapper">{title}</div> : title;
}

function ErrorNotice({ message, children }: { message: string; children?: ReactNode }) {
  return <div className="form-notice" role="alert"><p>{message}</p>{children}</div>;
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
  const [emailStep, setEmailStep] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState<MeResponse | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    request<MeResponse>('/api/me', { signal: controller.signal }).then(setMe).catch(() => {});
    return () => controller.abort();
  }, []);
  async function createList(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    if (!name.trim()) { setError('Give your list a name first.'); return; }
    setBusy(true); setError('');
    try {
      const session = await request<MeResponse>('/api/me'); setMe(session);
      if (!session.verified) { setEmailStep(true); return; }
      const result = await write<ListResponse>('/api/lists', 'POST', { name });
      navigate(`/${encodeURIComponent(result.list.slug)}`); window.scrollTo(0, 0);
    } catch (reason) {
      if (reason instanceof RequestError && reason.status === 401) { setMe(null); setEmailStep(true); }
      else setError(errorMessage(reason));
    } finally { setBusy(false); }
  }
  async function changeEmail() {
    setBusy(true); setError('');
    try { await write('/api/auth/logout', 'POST', {}); setMe(null); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  }
  return <main className="create-list-page">
    {emailStep ? <EmailRequestForm name={name.trim()} /> : <>
      <ChristmasTitle wrapped={false}>Gimme some freakin’ presents!</ChristmasTitle>
      <h2 className="sub-title">Make a gift list for your lame family by typing in the thing below.</h2>
      <form className="new_list" onSubmit={createList} aria-busy={busy}>
        <div className="form_block primary">
          <input type="text" aria-label="List name" name="name" maxLength={120} value={name} onChange={event => setName(event.target.value)}
            placeholder="Name your stupid list" disabled={busy} /><br />
          <SubmitLink disabled={busy}>create my list!</SubmitLink>
        </div>
        {error && <ErrorNotice message={error} />}
      </form>
      <p className="access-footer">{me?.verified ? <>Creating lists as {me.email}.{' '}
        <button className="text-button" disabled={busy} onClick={() => void changeEmail()}>Use another email</button>
      </> : <Link to="/auth/recover">Access my old lists</Link>}</p>
    </>}
  </main>;
}

function giftInput(gift: Gift): GiftDraft {
  return { name: gift.name, url: gift.url, image: gift.image, imageUrl: gift.imageUrl, price: gift.priceCents === null ? '' : String(gift.priceCents / 100) };
}

function GiftForm({ value, onChange, onSubmit, busy, editing, children, notice, onBack, onClose }: {
  value: GiftDraft;
  onChange: (value: GiftDraft) => void;
  onSubmit: () => void;
  busy: boolean;
  editing?: boolean;
  children?: ReactNode;
  notice?: ReactNode;
  onBack?: () => void;
  onClose?: () => void;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  return <form ref={formRef} aria-busy={busy} className={editing ? 'edit_gift' : 'new_gift'} onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
    {onClose && <button type="button" className="text-button gift-close" aria-label="Close gift editor" onClick={onClose}>[X]</button>}
    {onBack ? <a href="#" className="gift-back" aria-disabled={busy} onClick={event => {
      event.preventDefault(); if (!busy) onBack();
    }}>{'< back'}</a> : <h3 className="add-message">Add a sweet present!</h3>}
    <div className="form_block primary">
      <input type="text" disabled={busy} aria-label="Gift name" name="name" value={value.name} placeholder="Name" autoFocus={!!onBack}
        onChange={(event) => onChange({ ...value, name: event.target.value })} />{' '}
      <input type="text" disabled={busy} aria-label="Gift URL" name="url" value={value.url} placeholder="URL"
        onChange={(event) => onChange({ ...value, url: event.target.value })} />{' '}
      <input type="text" disabled={busy} aria-label="Price in dollars" name="price" value={value.price} placeholder="Price"
        onChange={(event) => onChange({ ...value, price: event.target.value })} /><br />
      <div className="gift-footer">
        <ImagePicker value={value} onChange={onChange} busy={busy} formRef={formRef} />
        {children && <div className="gift-secondary-actions">{children}</div>}
        <div className="gift-actions">
          <SubmitLink disabled={busy}>{editing ? 'update my gift!' : 'create my gift!'}</SubmitLink>
          {busy && <span className="gift-saving" role="status">Saving…</span>}
        </div>
      </div>
    </div>
    {notice}
  </form>;
}

function NewGiftForm({ listId, value, onChange, onSubmit, busy, notice }: {
  listId: number; value: GiftDraft; onChange: (value: GiftDraft) => void;
  onSubmit: () => void; busy: boolean; notice?: ReactNode;
}) {
  const [stage, setStage] = useState<'url' | 'loading' | 'edit'>('url');
  const [message, setMessage] = useState('');
  const [autoLookup, setAutoLookup] = useState(true);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);
  const suggest = useCallback(async () => {
    if (busy || active.current || !safeRemoteUrl(value.url.trim())) return;
    const controller = new AbortController(); active.current = controller;
    setStage('loading'); setMessage('');
    const timeout = setTimeout(() => {
      if (active.current !== controller || controller.signal.aborted) return;
      controller.abort(); active.current = null;
      setMessage('That lookup took too long. You can fill in the gift below.'); setStage('edit');
    }, GIFT_FORM_WAIT_MS);
    controller.signal.addEventListener('abort', () => clearTimeout(timeout), { once: true });
    try {
      const result = await request<GiftSuggestion>(`/api/lists/${listId}/gift-suggestion`, {
        method: 'POST', body: JSON.stringify({ url: value.url.trim() }), signal: controller.signal,
      });
      if (controller.signal.aborted || active.current !== controller) return;
      onChange(result.draft); setMessage(result.notice ?? '');
    } catch (error) {
      if (controller.signal.aborted || active.current !== controller) return;
      setMessage(errorMessage(error));
    } finally {
      clearTimeout(timeout);
      if (!controller.signal.aborted && active.current === controller) {
        active.current = null; setStage('edit');
      }
    }
  }, [busy, listId, onChange, value.url]);
  useEffect(() => {
    if (stage !== 'url' || !autoLookup || busy || !safeRemoteUrl(value.url.trim())) return;
    // Let typing or pasting settle before spending a lookup allowance.
    const timer = setTimeout(() => { void suggest(); }, 400);
    return () => clearTimeout(timer);
  }, [autoLookup, busy, stage, suggest, value.url]);
  if (stage === 'edit') return <GiftForm value={value} onChange={onChange} onSubmit={onSubmit} busy={busy}
    onBack={() => {
      onChange({ ...blankGift, url: value.url });
      setAutoLookup(false); setMessage(''); setStage('url');
    }}
    notice={<>{message && <p role="status">{message}</p>}{notice}</>} />;
  return <form className="new_gift" onSubmit={event => { event.preventDefault(); void suggest(); }} aria-busy={stage === 'loading'}>
    <h3 className="add-message">Add a sweet present!</h3>
    <div className="form_block primary">
      <input type="text" aria-label="Gift URL" placeholder="Paste a gift link" maxLength={2048} required
        autoFocus={!autoLookup} value={value.url} onChange={event => {
          setAutoLookup(true); onChange({ ...value, url: event.target.value });
        }} disabled={busy || stage === 'loading'} /><br />
      {stage === 'loading' && <span className="gift-saving" role="status">Checking your gift…</span>}
      <button type="button" className="text-button" disabled={busy} onClick={() => {
        active.current?.abort(); active.current = null;
        onChange({ ...blankGift });
        setAutoLookup(false); setMessage(''); setStage('edit');
      }}>Manually enter gift</button>
    </div>
    {notice}
  </form>;
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
  const [noticeTarget, setNoticeTarget] = useState<'new-gift' | 'list' | 'reorder' | number>('new-gift');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [newGift, setNewGift] = useState<GiftDraft>({ ...blankGift });
  const [giftFormKey, setGiftFormKey] = useState(0);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [giftDrafts, setGiftDrafts] = useState<Record<number, GiftDraft>>({});
  const [listName, setListName] = useState('');
  const mutationLock = useRef(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const editTriggerRef = useRef<HTMLAnchorElement>(null);

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
    const closeEditor = (event: PointerEvent) => {
      if (event.target instanceof Node && !editorRef.current?.contains(event.target)) setEditingId(null);
    };
    // Check before a click can remove its own target (for example a preview's ×).
    document.addEventListener('pointerdown', closeEditor);
    return () => document.removeEventListener('pointerdown', closeEditor);
  }, [editingId]);

  async function mutate(operation: () => Promise<ListResponse>, target: typeof noticeTarget = 'new-gift'): Promise<boolean> {
    if (mutationLock.current || conflict) return false;
    mutationLock.current = true;
    setBusy(true);
    setError('');
    setNoticeTarget(target);
    try {
      const result = await operation();
      setData(result);
      setEditingId(null);
      setGiftDrafts({});
      setNewGift({ ...blankGift });
      window.scrollTo(0, 0);
      return true;
    } catch (reason) {
      if (reason instanceof RequestError && reason.status === 409) setConflict(true);
      else setError(errorMessage(reason));
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

  function writeGift(path: string, method: string, draft: GiftDraft): Promise<ListResponse> {
    const { imageFile, imageUrl: _preview, ...fields } = draft;
    const payload = { ...fields, ...common };
    if (!imageFile) return write<ListResponse>(path, method, payload);
    const form = new FormData();
    form.set('gift', JSON.stringify(payload));
    form.set('imageFile', imageFile);
    return request<ListResponse>(path, { method, body: form });
  }

  async function addGift() {
    if (await mutate(() => writeGift(`${mutationPath}/gifts`, 'POST', newGift))) setGiftFormKey(key => key + 1);
  }

  async function saveGift() {
    if (editingId === null) return;
    await mutate(() => writeGift(`${mutationPath}/gifts/${editingId}`, 'PUT', giftDrafts[editingId]), editingId);
  }

  async function deleteGift(gift: Gift) {
    await mutate(() => write<ListResponse>(`${mutationPath}/gifts/${gift.id}`, 'DELETE', common), gift.id);
  }

  async function reorderGifts(from: number, to: number) {
    if (!data?.canEdit || mutationLock.current || conflict || from === to
      || from < 0 || to < 0 || from >= data.gifts.length || to >= data.gifts.length) return;
    const previous = data;
    const gifts = [...data.gifts];
    const [moved] = gifts.splice(from, 1);
    gifts.splice(to, 0, moved);
    mutationLock.current = true;
    setBusy(true);
    setError('');
    setNoticeTarget('reorder');
    setData({ ...data, gifts });
    try {
      // Reordering keeps draft fields and scroll position, unlike submitting a gift.
      setData(await write<ListResponse>(`${mutationPath}/reorder`, 'POST', { giftIds: gifts.map(gift => gift.id), ...common }));
    } catch (reason) {
      setData(previous);
      if (reason instanceof RequestError && reason.status === 409) setConflict(true);
      else setError(`Couldn’t save the new order. ${errorMessage(reason)}`);
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }

  async function saveTitle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await mutate(() => write<ListResponse>(mutationPath, 'PUT', { name: listName, ...common }), 'list')) {
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
      if (reason instanceof RequestError && reason.status === 409) setConflict(true);
      else setError(errorMessage(reason));
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }

  const notices = <>
    {error && !conflict && <ErrorNotice message={error} />}
    {conflict && <div className="form-notice" role="alert">
      <p>This list changed in another tab. Load the latest version before trying again. Your unsaved fields will be kept.</p>
      {error && <p>{error}</p>}
      <button type="button" disabled={busy} onClick={reloadLatest}>Load latest list</button>
    </div>}
  </>;

  if (editTitle) return <main>
    {data.canEdit ? <form className="edit_list" onSubmit={saveTitle}>
      <div className="form_block primary">
        <input type="text" aria-label="List name" value={listName} onChange={(event) => setListName(event.target.value)} placeholder="Name your stupid list" /><br />
        <SubmitLink disabled={disabled}>update my list!</SubmitLink>{' '}
        <a href="#" style={{ color: 'red' }} aria-disabled={disabled || undefined} onClick={(event) => { event.preventDefault(); if (!disabled) void deleteList(); }}>delete</a>
      </div>
      {notices}
    </form> : <ErrorNotice message="This browser does not have editing access to this list." />}
  </main>;

  return <main className={`list-page${data.canEdit && data.gifts.length ? ' list-page-with-rail' : ''}`}>
    <ChristmasTitle action={data.canEdit
      ? <Link className="edit-list-title edit-link" to={`/edit/${list.id}`} aria-label="Edit list name" /> : undefined}>{list.name}</ChristmasTitle>
    <ExistingAccessNotice listId={list.id} canEdit={data.canEdit} />
    {data.canEdit && <aside aria-label="Add a gift">
      <NewGiftForm key={giftFormKey} listId={list.id} value={newGift} onChange={setNewGift} onSubmit={addGift} busy={disabled}
        notice={noticeTarget === 'new-gift' ? notices : undefined} />
    </aside>}
    {typeof noticeTarget === 'number' && noticeTarget !== editingId && notices}
    {data.canEdit && <Suspense fallback={null}>
      <GiftRail gifts={data.gifts} disabled={disabled} busy={busy} onReorder={(from, to) => void reorderGifts(from, to)} />
    </Suspense>}
    {noticeTarget === 'reorder' && (error || conflict) && <div className="gift-reorder-notice">{notices}</div>}
    <div className="gifts">
      {data.gifts.map(gift => <article className="gift" key={gift.id} aria-label={gift.name}>
        <img src={giftImageUrl(gift.imageUrl)} alt={gift.imageUrl ? gift.name : ''} /><br />
        <a href={safeRemoteUrl(gift.url) ?? ''}>{gift.name}</a><br />
        <span className="price">{gift.priceCents !== null ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(gift.priceCents / 100) : ''}</span>
        {data.canEdit && <> <div className="controls">
          <a href="#" className="toggle-edit-controls edit-link" aria-label={`Edit ${gift.name}`} onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            editTriggerRef.current = event.currentTarget;
            setGiftDrafts((drafts) => ({ ...drafts, [gift.id]: drafts[gift.id] ?? giftInput(gift) }));
            setEditingId(gift.id);
          }}>edit</a>
          <div className={`edit-gift-container hidden${editingId === gift.id ? ' active' : ''}`} ref={editingId === gift.id ? editorRef : undefined}>
            {editingId === gift.id && <GiftForm value={giftDrafts[gift.id]} onChange={(value) => setGiftDrafts((drafts) => ({ ...drafts, [gift.id]: value }))}
              onSubmit={saveGift} busy={disabled} editing notice={noticeTarget === gift.id ? notices : undefined}
              onClose={() => { setEditingId(null); editTriggerRef.current?.focus(); }}>
              <a href="#" aria-label={`Delete ${gift.name}`} aria-disabled={disabled || undefined} onClick={(event) => { event.preventDefault(); if (!disabled) void deleteGift(gift); }}>delete</a>
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
    <Route path="/auth/recover" element={<RecoveryPage />} />
    <Route path="/auth/access" element={<ConfirmationPage />} />
    <Route path="/local/all-lists" element={<AllListsPage />} />
    <Route path="/edit/:id" element={<RoutedList editTitle />} />
    <Route path="/:slug" element={<RoutedList />} />
    <Route path="*" element={<main><p>That page could not be found.</p><Link to="/">Make a list of your own</Link></main>} />
  </Routes>;
}
