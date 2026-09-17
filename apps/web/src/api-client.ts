// Shared fetch helpers for Availability screens: CSRF header, readable errors with field details.
export function useApi(csrf: string) {
  return async function call(path: string, method = 'GET', data?: unknown, raw?: string) {
    const r = await fetch('/api/' + path, {
      method,
      headers:
        raw !== undefined
          ? { 'Content-Type': 'text/csv', 'X-CSRF-Token': csrf }
          : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
      body: raw !== undefined ? raw : data === undefined ? undefined : JSON.stringify(data),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const error: Error & { fields?: { column: string; message: string }[] } = Error(
        d.error?.message ||
          ([502, 503, 504].includes(r.status)
            ? 'The server is temporarily unavailable. Wait a few seconds and retry.'
            : 'Could not complete this request. Please retry.'),
      );
      error.fields = d.error?.fields;
      throw error;
    }
    return d;
  };
}

export async function download(path: string, fallbackName: string) {
  const r = await fetch('/api/' + path);
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw Error(d.error?.message || 'Download failed. Please retry.');
  }
  const url = URL.createObjectURL(await r.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download =
    /filename="([^"]+)"/.exec(r.headers.get('Content-Disposition') || '')?.[1] || fallbackName;
  a.click();
  URL.revokeObjectURL(url);
}
