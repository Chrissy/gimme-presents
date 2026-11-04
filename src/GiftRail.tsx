import { useState } from 'react';
import { DragDropProvider } from '@dnd-kit/react';
import { isSortable, useSortable } from '@dnd-kit/react/sortable';
import type { Gift } from '../shared/api';
import { giftImageUrl } from './urls';

function Thumbnail({ gift, index, disabled }: { gift: Gift; index: number; disabled: boolean }) {
  const { ref, handleRef, isDragging } = useSortable({ id: gift.id, index, disabled });
  const [failedImage, setFailedImage] = useState<string>();
  const image = giftImageUrl(gift.imageUrl);

  return <li ref={ref} className="gift-rail-item" data-dragging={isDragging || undefined}>
    <button ref={handleRef} type="button" className="gift-rail-thumbnail" aria-label={`Reorder ${gift.name}`}
      aria-disabled={disabled}>
      {image && failedImage !== image
        ? <img src={image} alt="" draggable={false} loading="lazy" onError={() => setFailedImage(image)} />
        : <span aria-hidden="true">?</span>}
    </button>
  </li>;
}

export default function GiftRail({ gifts, disabled, busy, onReorder }: {
  gifts: Gift[];
  disabled: boolean;
  busy: boolean;
  onReorder: (from: number, to: number) => void;
}) {
  if (!gifts.length) return null;

  return <aside className="gift-rail" aria-label="Reorder gifts" aria-busy={busy}>
    <DragDropProvider onBeforeDragStart={event => { if (disabled) event.preventDefault(); }}
      onDragEnd={event => {
        if (event.canceled || disabled) return;
        const { source } = event.operation;
        if (isSortable(source) && source.initialIndex !== source.index) onReorder(source.initialIndex, source.index);
      }}>
      <ol className="gift-rail-list">
        {gifts.map((gift, index) => <Thumbnail key={gift.id} gift={gift} index={index} disabled={disabled || gifts.length < 2} />)}
      </ol>
    </DragDropProvider>
  </aside>;
}
