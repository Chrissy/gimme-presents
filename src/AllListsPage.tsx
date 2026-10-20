import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { LocalListsResponse } from '../shared/api';
import { errorMessage, request, RequestError } from './api';

export function AllListsPage() {
  const [data, setData] = useState<LocalListsResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    request<LocalListsResponse>('/api/local/lists', { signal: controller.signal }).then(setData).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason instanceof RequestError && reason.status === 404
        ? 'That page could not be found.' : errorMessage(reason));
    });
    return () => controller.abort();
  }, []);

  if (error) return <main><p role="alert">{error}</p></main>;
  return <main>
    <h1>All lists</h1>
    {data ? <>
      <p>{data.lists.length} {data.lists.length === 1 ? 'list' : 'lists'}</p>
      <ul>
        {data.lists.map(list => <li key={list.id}>
          <Link to={`/${encodeURIComponent(list.slug)}`}>{list.name.trim() ? list.name : `Untitled list #${list.id}`}</Link>
          {' — '}<time dateTime={list.createdAt}>{list.createdAt.slice(0, 10)}</time>
          {' — '}{list.giftCount} {list.giftCount === 1 ? 'gift' : 'gifts'}
        </li>)}
      </ul>
    </> : <p>Loading lists…</p>}
  </main>;
}
