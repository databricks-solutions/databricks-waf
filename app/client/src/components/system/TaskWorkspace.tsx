import { useId, type ReactNode } from 'react';

export interface TaskWorkspaceProps {
  readonly queue: ReactNode;
  readonly task: ReactNode;
  readonly queueLabel: string;
  readonly taskLabel: string;
}

/**
 * A selection queue beside the work it opens.
 *
 * This is deliberately not a universal pane shell: it has no fixed side, viewport height, row fitting,
 * active-plane switcher or optional third inspector. At compact widths the task follows the queue in normal
 * document flow, preserving reading and keyboard order.
 */
export function TaskWorkspace({ queue, task, queueLabel, taskLabel }: TaskWorkspaceProps) {
  const taskId = `task-workspace-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const skipLabel = `${taskLabel.charAt(0).toLowerCase()}${taskLabel.slice(1)}`;

  return (
    <div className="wa-task-workspace">
      <div className="wa-task-workspace-skip">
        <a href={`#${taskId}`}>Skip to {skipLabel}</a>
      </div>
      <section className="wa-task-workspace-queue" aria-label={queueLabel}>
        {queue}
      </section>
      <section id={taskId} className="wa-task-workspace-main" aria-label={taskLabel} tabIndex={-1}>
        {task}
      </section>
    </div>
  );
}
