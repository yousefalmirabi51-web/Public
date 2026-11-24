import type { DepartmentCode, ReasonCode, TicketDetail, TicketKind, UrgencyLevel } from '../types/domain';

const TOKEN_STORAGE_KEY = 'almazaq_auth_token';
const OFFLINE_QUEUE_KEY = 'almazaq_offline_ticket_queue';
const OFFLINE_ACTION_QUEUE_KEY = 'almazaq_offline_action_queue';

export interface OfflineTicketPayload {
  client_request_id: string;
  invoice_number: string;
  item_name: string;
  quantity: number;
  reason_code: ReasonCode;
  urgency_level?: UrgencyLevel;
  ticket_kind?: TicketKind;
  problem_description: string;
  target_department?: DepartmentCode;
  created_via_support?: boolean;
  parent_ticket_id?: number | null;
  queued_at: string;
  status: 'pending' | 'syncing' | 'failed';
  last_error?: string;
}

export interface OfflineActionPayload {
  client_request_id: string;
  path: string;
  method: 'POST' | 'PUT' | 'PATCH';
  body: Record<string, unknown>;
  label_ar: string;
  queued_at: string;
  status: 'pending' | 'syncing' | 'failed';
  last_error?: string;
}

export function generateClientRequestId(prefix = 'req'): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function isNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  if (err instanceof TypeError) return true;
  const status = (err as { status?: number })?.status;
  return typeof status === 'number' && status >= 502 && status <= 504;
}

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

export function getOfflineQueue(): OfflineTicketPayload[] {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    return raw ? (JSON.parse(raw) as OfflineTicketPayload[]) : [];
  } catch {
    return [];
  }
}

export function saveOfflineQueue(items: OfflineTicketPayload[]) {
  try {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(items));
  } catch {
    // ignore storage errors
  }
}

export function enqueueOfflineTicket(
  payload: Omit<OfflineTicketPayload, 'queued_at' | 'status'>
): OfflineTicketPayload[] {
  const list = getOfflineQueue();
  const next: OfflineTicketPayload[] = [
    ...list.filter((i) => i.client_request_id !== payload.client_request_id),
    {
      ...payload,
      queued_at: new Date().toISOString(),
      status: 'pending',
    },
  ];
  saveOfflineQueue(next);
  return next;
}

export function getOfflineActionQueue(): OfflineActionPayload[] {
  try {
    const raw = localStorage.getItem(OFFLINE_ACTION_QUEUE_KEY);
    return raw ? (JSON.parse(raw) as OfflineActionPayload[]) : [];
  } catch {
    return [];
  }
}

export function saveOfflineActionQueue(items: OfflineActionPayload[]) {
  try {
    localStorage.setItem(OFFLINE_ACTION_QUEUE_KEY, JSON.stringify(items));
  } catch {
    // ignore storage errors
  }
}

export function enqueueOfflineAction(
  payload: Omit<OfflineActionPayload, 'queued_at' | 'status'>
): OfflineActionPayload[] {
  const list = getOfflineActionQueue();
  const next: OfflineActionPayload[] = [
    ...list.filter((i) => i.client_request_id !== payload.client_request_id),
    {
      ...payload,
      queued_at: new Date().toISOString(),
      status: 'pending',
    },
  ];
  saveOfflineActionQueue(next);
  return next;
}

export function getTotalOfflineQueueCount(): number {
  return getOfflineQueue().length + getOfflineActionQueue().length;
}

export async function apiRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let data: unknown = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }

  if (!res.ok) {
    const errMsg = (data as { error?: string })?.error || `خطأ في الخادم (${res.status})`;
    const err = new Error(errMsg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  return data as T;
}

export async function syncOfflineTicketQueue(): Promise<{ synced: number; remaining: OfflineTicketPayload[] }> {
  const queue = getOfflineQueue();
  if (queue.length === 0) return { synced: 0, remaining: [] };

  let synced = 0;
  const remaining: OfflineTicketPayload[] = [];

  for (const item of queue) {
    try {
      await apiRequest<{ ticket: TicketDetail }>('/api/tickets', {
        method: 'POST',
        body: JSON.stringify({
          client_request_id: item.client_request_id,
          invoice_number: item.invoice_number,
          item_name: item.item_name,
          quantity: item.quantity,
          reason_code: item.reason_code,
          urgency_level: item.urgency_level || 'normal',
          ticket_kind: item.ticket_kind || 'stall',
          problem_description: item.problem_description,
          target_department: item.target_department,
          created_via_support: item.created_via_support,
          parent_ticket_id: item.parent_ticket_id,
        }),
      });
      synced++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'فشل الاتصال بالخادم';
      const status = (err as { status?: number })?.status;
      if (status === 409) {
        synced++;
      } else {
        remaining.push({ ...item, status: 'failed', last_error: msg });
      }
    }
  }

  saveOfflineQueue(remaining);
  return { synced, remaining };
}

export async function syncOfflineActionQueue(): Promise<{ synced: number; remaining: OfflineActionPayload[] }> {
  const queue = getOfflineActionQueue();
  if (queue.length === 0) return { synced: 0, remaining: [] };

  let synced = 0;
  const remaining: OfflineActionPayload[] = [];

  for (const item of queue) {
    try {
      await apiRequest(item.path, {
        method: item.method,
        body: JSON.stringify({
          ...item.body,
          client_request_id: item.client_request_id,
        }),
      });
      synced++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'فشل الاتصال بالخادم';
      const status = (err as { status?: number })?.status;
      if (status === 409) {
        synced++;
      } else if (status === 400 || status === 403 || status === 404) {
        // Non-retriable validation/RBAC error — keep flagged as failed rather than spamming indefinitely
        remaining.push({ ...item, status: 'failed', last_error: msg });
      } else {
        remaining.push({ ...item, status: 'failed', last_error: msg });
      }
    }
  }

  saveOfflineActionQueue(remaining);
  return { synced, remaining };
}

export async function syncAllOfflineQueues(): Promise<{
  synced: number;
  remainingCount: number;
}> {
  const ticketsRes = await syncOfflineTicketQueue();
  const actionsRes = await syncOfflineActionQueue();
  return {
    synced: ticketsRes.synced + actionsRes.synced,
    remainingCount: ticketsRes.remaining.length + actionsRes.remaining.length,
  };
}
