export const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
export async function hash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export const localMail = (env: Env) => env.ENVIRONMENT === 'local' && env.EMAIL_MODE === 'capture';
async function encryptionKey(env: Env) {
  const raw = localMail(env) ? new Uint8Array(32).fill(17)
    : Uint8Array.from(atob(env.EMAIL_ENCRYPTION_KEY || ''), c => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error('Email encryption key unavailable');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(env: Env, payload: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(env), new TextEncoder().encode(JSON.stringify(payload))));
  return `${btoa(String.fromCharCode(...iv))}.${btoa(String.fromCharCode(...bytes))}`;
}
export async function decrypt<T>(env: Env, payload: string): Promise<T> {
  const [iv, data] = payload.split('.').map(s => Uint8Array.from(atob(s), c => c.charCodeAt(0)));
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await encryptionKey(env), data))) as T;
}
