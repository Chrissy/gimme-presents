import type { ApiError } from '../shared/api';

export class RequestError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        'X-Requested-With': 'gimme-presents',
        ...options.headers,
      },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new RequestError('Couldn’t connect. Check your connection and try again.', 0);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload
      && typeof (payload as ApiError).error === 'string'
      ? (payload as ApiError).error
      : 'Something went wrong. Please try again.';
    throw new RequestError(message, response.status);
  }
  if (!payload) throw new RequestError('The server returned an unexpected response. Please try again.', response.status);
  return payload as T;
}

export function write<T>(path: string, method: string, body: unknown): Promise<T> {
  return request<T>(path, { method, body: JSON.stringify(body) });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
