import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import type { GiftInput } from '../shared/api';
import { IMAGE_SIZE_ERROR, MAX_IMAGE_BYTES } from '../shared/image-limits';

export interface GiftDraft extends GiftInput {
  imageFile?: File;
  imageUrl?: string;
}

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function imageLink(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Show a local validation message before adding the preview. */ }
}

export function ImagePicker({ value, onChange, busy, formRef }: {
  value: GiftDraft;
  onChange: (draft: GiftDraft) => void;
  busy: boolean;
  formRef: RefObject<HTMLFormElement | null>;
}) {
  const [panel, setPanel] = useState<'menu' | 'url' | null>(null);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [failedPreview, setFailedPreview] = useState(false);
  const [objectUrl, setObjectUrl] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const preview = value.imageFile ? objectUrl : value.imageUrl || imageLink(value.image);
  const hasImage = Boolean(value.imageFile || value.imageUrl || value.image);

  useEffect(() => {
    if (!value.imageFile) { setObjectUrl(''); return; }
    const next = URL.createObjectURL(value.imageFile);
    setObjectUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [value.imageFile]);
  useEffect(() => { setFailedPreview(false); }, [preview]);
  useEffect(() => {
    if (panel === 'url') urlRef.current?.focus();
    else if (panel === 'menu') firstOptionRef.current?.focus();
  }, [panel]);
  useEffect(() => {
    if (!panel) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setPanel(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [panel]);

  function chooseFile(file: File) {
    if (busy) return;
    if (!IMAGE_TYPES.includes(file.type) && !(file.type === '' && /\.(png|jpe?g|gif|webp)$/i.test(file.name))) {
      setError('Choose a PNG, JPEG, GIF, or WebP image.');
      return;
    }
    if (!file.size || file.size > MAX_IMAGE_BYTES) {
      setError(IMAGE_SIZE_ERROR);
      return;
    }
    onChange({ ...value, image: '', imageUrl: undefined, imageFile: file, removeImage: false });
    setError('');
    setPanel(null);
    plusRef.current?.focus();
  }

  // Scope image paste to this gift form; ordinary text paste is untouched.
  useEffect(() => {
    const form = formRef.current;
    const paste = (event: ClipboardEvent) => {
      const item = Array.from(event.clipboardData?.items ?? []).find(item => item.kind === 'file' && item.type.startsWith('image/'));
      const file = item?.getAsFile();
      if (!file || busy) return;
      event.preventDefault();
      chooseFile(file);
    };
    form?.addEventListener('paste', paste);
    return () => form?.removeEventListener('paste', paste);
  });

  function addUrl() {
    const source = imageLink(url);
    if (!source || source.length > 2048) { setError('Paste a valid HTTP or HTTPS image URL.'); return; }
    onChange({ ...value, image: source, imageUrl: undefined, imageFile: undefined, removeImage: false });
    setError('');
    setUrl('');
    setPanel(null);
    plusRef.current?.focus();
  }

  return <div className="image-picker" ref={rootRef} onKeyDown={event => {
    if (event.key === 'Escape' && panel) { event.stopPropagation(); setPanel(null); plusRef.current?.focus(); }
  }}>
    {hasImage && <div className="image-preview">
      {preview && !failedPreview
        ? <img src={preview} alt="Image preview" referrerPolicy="no-referrer" onError={() => setFailedPreview(true)} />
        : <span className="image-preview-failed">Preview unavailable</span>}
      <button type="button" className="image-remove" aria-label="Remove image" disabled={busy} onClick={() => {
        onChange({ ...value, image: '', imageUrl: undefined, imageFile: undefined, removeImage: true });
        setError('');
        plusRef.current?.focus();
      }}>×</button>
    </div>}
    {error && <p className="image-error" role="alert">{error}</p>}
    <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" aria-label="Upload image" hidden disabled={busy}
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) chooseFile(file); }} />
    <button ref={plusRef} type="button" className="image-add" aria-label={hasImage ? 'Replace image' : 'Add image'}
      aria-expanded={panel !== null} aria-controls={panel ? panelId : undefined} aria-haspopup="dialog" disabled={busy}
      onClick={() => { setPanel(panel ? null : 'menu'); setError(''); }}>+</button>
    {panel && <div className="image-popover" id={panelId} role="dialog" aria-label="Add image">
      {panel === 'menu' ? <>
        <button ref={firstOptionRef} type="button" onClick={() => { setPanel(null); fileRef.current?.click(); }}>Upload from device</button>
        <button type="button" onClick={() => { setUrl(''); setPanel('url'); }}>Paste image URL</button>
      </> : <>
        <label htmlFor={`${panelId}-url`}>Image URL</label>
        <input ref={urlRef} id={`${panelId}-url`} type="url" value={url} placeholder="https://…" onChange={event => setUrl(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); addUrl(); } }} />
        <button type="button" onClick={addUrl}>Add image</button>
      </>}
    </div>}
  </div>;
}
