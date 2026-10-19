/** Only same-site relative paths are allowed as post-login destinations (prevents open redirects). */
export function safeNext(next: string | string[] | undefined, fallback = '/account'): string {
  const value = Array.isArray(next) ? next[0] : next;
  if (!value) return fallback;
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  return value;
}
