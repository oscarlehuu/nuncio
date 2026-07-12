interface CrewTaskLookup {
  findById(id: string): { status: string; sessionId: string | null } | null | undefined;
}

export interface CrewTaskStopTarget {
  sessionId: string | null;
  unresolved: boolean;
}

export async function resolveCrewTaskStopTarget(
  tasks: CrewTaskLookup, taskId: string,
): Promise<CrewTaskStopTarget> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const task = tasks.findById(taskId);
    if (!task || task.status !== 'RUNNING' || task.sessionId) {
      return { sessionId: task?.sessionId ?? null, unresolved: false };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const task = tasks.findById(taskId);
  return {
    sessionId: task?.sessionId ?? null,
    unresolved: task?.status === 'RUNNING' && !task.sessionId,
  };
}
