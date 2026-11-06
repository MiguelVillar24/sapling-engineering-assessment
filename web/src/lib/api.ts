import type { AppState, Conversation, HandoffRequest, RequestStatus, Settings, ThreadResponse } from '../types';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export const getState = () => api<AppState>('/api/state');
export const getThread = (id: string) => api<ThreadResponse>(`/api/conversations/${id}`);
export const createConversation = () => api<Conversation>('/api/conversations', { method: 'POST' });
export const sendMessage = (conversationId: string, from: 'patient' | 'clinic', body: string) =>
  api<unknown>(`/api/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ from, body }) });
export const listRequests = () => api<HandoffRequest[]>('/api/requests');
export const updateRequest = (id: string, patch: { status?: RequestStatus; staff_note?: string | null }) =>
  api<HandoffRequest>(`/api/requests/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
export const setClock = (input: { now?: string; mode?: 'frozen' | 'running'; reset?: boolean }) =>
  api<Settings>('/api/settings/clock', { method: 'PUT', body: JSON.stringify(input) });
export const resetDemo = () => api<unknown>('/api/admin/reset', { method: 'POST' });
export const exportAll = () => api<Record<string, unknown>>('/api/export');
