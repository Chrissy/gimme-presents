export function safeRemoteUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function giftImageUrl(value: string): string | undefined {
  return /^\/media\/[a-f0-9-]+\.(png|jpg|gif|webp)$/.test(value) ? value : safeRemoteUrl(value);
}
