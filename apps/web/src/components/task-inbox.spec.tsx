import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { Task } from '../lib/tasks-api';
import type { ModelProvider } from '../lib/model-providers';

vi.mock('./project-picker', () => ({
  ProjectPicker: ({ onChange }: { onChange: (p: string) => void }) => (
    <button type="button" onClick={() => onChange('/code/nuncio')}>
      pick-project
    </button>
  ),
}));

vi.mock('./branch-picker', () => ({
  BranchPicker: () => <div>branch-picker</div>,
}));

vi.mock('./model-picker', () => ({
  ModelPicker: () => <div>model-picker</div>,
}));

const tasksApiMocks = vi.hoisted(() => ({
  fetchTasks: vi.fn<() => Promise<Task[]>>(async () => []),
  createTask: vi.fn(),
  cancelTask: vi.fn(),
  retryTask: vi.fn(),
}));
vi.mock('../lib/tasks-api', async () => {
  const actual = await vi.importActual<typeof import('../lib/tasks-api')>('../lib/tasks-api');
  return { ...actual, ...tasksApiMocks };
});

import { TaskInbox } from './task-inbox';

const PROVIDERS: ModelProvider[] = [
  {
    id: 'pi',
    name: 'Pi',
    groups: [
      {
        id: 'anthropic',
        name: 'Anthropic',
        models: [{ id: 'anthropic:claude-fable-5', name: 'Claude Fable 5' }],
      },
    ],
  },
];

function task(over: Partial<Task>): Task {
  return {
    id: over.id ?? Math.random().toString(36).slice(2, 10),
    prompt: 'do something',
    status: 'QUEUED',
    provider: 'pi',
    model: null,
    modelOptions: null,
    projectPath: '/code/nuncio',
    baseBranch: null,
    useWorktree: false,
    workspace: null,
    sessionId: null,
    outcome: null,
    createdAt: 0,
    updatedAt: 0,
    startedAt: null,
    finishedAt: null,
    ...over,
  };
}

function renderInbox() {
  return render(
    <MemoryRouter>
      <TaskInbox providers={PROVIDERS} />
    </MemoryRouter>,
  );
}

describe('TaskInbox', () => {
  beforeEach(() => {
    tasksApiMocks.fetchTasks.mockReset().mockResolvedValue([]);
    tasksApiMocks.createTask.mockReset();
    tasksApiMocks.cancelTask.mockReset();
    tasksApiMocks.retryTask.mockReset();
  });

  it('buckets tasks into lanes', async () => {
    tasksApiMocks.fetchTasks.mockResolvedValue([
      task({ id: 'q1', prompt: 'queued task', status: 'QUEUED' }),
      task({ id: 'r1', prompt: 'running task', status: 'RUNNING', sessionId: 's1' }),
      task({ id: 'n1', prompt: 'blocked task', status: 'RUNNING', pendingInput: true, sessionId: 's2' }),
      task({ id: 'd1', prompt: 'done task', status: 'DONE', sessionId: 's3', outcome: { verify: { ok: true } } }),
    ]);
    renderInbox();

    await waitFor(() => expect(screen.getByText('queued task')).toBeInTheDocument());
    expect(screen.getByLabelText(/queued lane/i)).toHaveTextContent('queued task');
    expect(screen.getByLabelText(/running lane/i)).toHaveTextContent('running task');
    expect(screen.getByLabelText(/needs you lane/i)).toHaveTextContent('blocked task');
    expect(screen.getByLabelText(/done lane/i)).toHaveTextContent('done task');
    // Verify outcome renders as a chip on the finished card.
    expect(screen.getByLabelText(/checks passed/i)).toBeInTheDocument();
  });

  it('cancels a queued task and retries a finished one', async () => {
    tasksApiMocks.fetchTasks.mockResolvedValue([
      task({ id: 'q1', prompt: 'queued task', status: 'QUEUED' }),
      task({ id: 'f1', prompt: 'failed task', status: 'FAILED' }),
    ]);
    renderInbox();
    await waitFor(() => expect(screen.getByText('queued task')).toBeInTheDocument());

    await userEvent.click(screen.getByRole('button', { name: /cancel task queued task/i }));
    expect(tasksApiMocks.cancelTask).toHaveBeenCalledWith('q1');

    await userEvent.click(screen.getByRole('button', { name: /retry task failed task/i }));
    expect(tasksApiMocks.retryTask).toHaveBeenCalledWith('f1');
  });

  it('links a started task to its session', async () => {
    tasksApiMocks.fetchTasks.mockResolvedValue([
      task({ id: 'r1', prompt: 'running task', status: 'RUNNING', sessionId: 'sess1' }),
    ]);
    renderInbox();
    await waitFor(() => expect(screen.getByText('running task')).toBeInTheDocument());

    const link = screen.getByRole('link', { name: /open session for running task/i });
    expect(link).toHaveAttribute('href', '/session/sess1');
  });

  it('submits a new task from the composer', async () => {
    tasksApiMocks.createTask.mockResolvedValue(task({ id: 'new1' }));
    renderInbox();

    await userEvent.click(screen.getByText('pick-project'));
    const textarea = screen.getByPlaceholderText(/delegate a task/i);
    await userEvent.type(textarea, 'build the feature');
    await userEvent.click(screen.getByRole('button', { name: /queue task/i }));

    await waitFor(() =>
      expect(tasksApiMocks.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: 'build the feature',
          projectPath: '/code/nuncio',
        }),
      ),
    );
  });
});
