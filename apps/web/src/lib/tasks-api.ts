import type { ModelOptionsMap } from './model-options';

export type TaskStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';

export interface Task {
  id: string;
  prompt: string;
  status: TaskStatus;
  provider: string | null;
  model: string | null;
  modelOptions: ModelOptionsMap | null;
  projectPath: string | null;
  baseBranch: string | null;
  useWorktree: boolean;
  workspace: string | null;
  sessionId: string | null;
  outcome: Record<string, unknown> | null;
  /** Server-derived: the linked session is waiting on the user. */
  pendingInput?: boolean;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface CreateTaskInput {
  prompt: string;
  provider?: string;
  model?: string;
  modelOptions?: ModelOptionsMap;
  projectPath?: string;
  baseBranch?: string;
  useWorktree?: boolean;
}

export async function fetchTasks(): Promise<Task[]> {
  const res = await fetch('/api/tasks');
  if (!res.ok) throw new Error('Failed to load tasks');
  return res.json();
}

export async function createTask(input: CreateTaskInput): Promise<Task> {
  const res = await fetch('/api/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error('Failed to create task');
  return res.json();
}

export async function cancelTask(id: string): Promise<Task> {
  const res = await fetch(`/api/tasks/${id}/cancel`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to cancel task');
  return res.json();
}

export async function retryTask(id: string): Promise<Task> {
  const res = await fetch(`/api/tasks/${id}/retry`, { method: 'POST' });
  if (!res.ok) throw new Error('Failed to retry task');
  return res.json();
}

export async function deleteTask(id: string): Promise<void> {
  const res = await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error('Failed to delete task');
}
