/** Public HTTP destinations shared by product and image imports. */
export function publicUrl(value: string): URL | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (value.length > 2048 || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port
    || !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':')
    || /(^|\.)(localhost|local|internal|home|lan|test|invalid)$/.test(host)) return null;
  return url;
}
