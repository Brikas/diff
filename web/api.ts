export type VersionMeta = {
  n: number; authors: string[]; mine: boolean; createdAt: number; updatedAt: number;
  name: string | null; restoredFrom: number | null; size: number;
};
export type VersionFull = VersionMeta & { left: string; right: string };
/** The caller: `secret` is their login key, returned only to them. */
export type Me = { id: string; name: string; secret: string };
export type DiffState = {
  role: 'edit' | 'view'; rev: number; versioning: boolean; me: string; you: { id: string; name: string };
  links: { edit?: string; view: string }; head: VersionFull; versions: VersionMeta[];
};
export type SaveResult =
  | { kind: 'saved'; minted: boolean; rev: number; head: VersionMeta }
  | { kind: 'unchanged'; rev: number; head: VersionMeta };

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(body?.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function call<T>(method: string, path: string, body?: unknown, keepalive = false): Promise<T> {
  const res = await fetch(path, {
    method, keepalive, credentials: 'same-origin',
    headers: body === undefined ? { 'X-Diff': '1' } : { 'Content-Type': 'application/json', 'X-Diff': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export const api = {
  me: () => call<Me>('GET', '/api/me'),
  rename: (name: string) => call<Me>('PUT', '/api/me', { name }),
  login: (secret: string) => call<Me>('POST', '/api/me/login', { secret }),
  create: (left: string, right: string) =>
    call<{ edit: string; view: string; rev: number; head: VersionMeta }>('POST', '/api/diffs', { left, right }),
  load: (token: string) => call<DiffState>('GET', `/api/d/${token}`),
  rev: (token: string) => call<{ rev: number }>('GET', `/api/d/${token}/rev`),
  save: (token: string, left: string, right: string, base: number, force = false, keepalive = false) =>
    call<SaveResult>('PUT', `/api/d/${token}`, { left, right, base, force }, keepalive),
  version: (token: string, n: number) => call<VersionFull>('GET', `/api/d/${token}/v/${n}`),
  name: (token: string, n: number, name: string | null) =>
    call<{ versions: VersionMeta[] }>('PUT', `/api/d/${token}/v/${n}/name`, { name }),
  restore: (token: string, n: number) => call<SaveResult>('POST', `/api/d/${token}/v/${n}/restore`),
  settings: (token: string, versioning: boolean) => call<{ versioning: boolean }>('PUT', `/api/d/${token}/settings`, { versioning }),
};
