/** Stop waiting at the deadline even if a provider does not honor cancellation. */
export async function withinSignal<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const canceled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([operation(), canceled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
