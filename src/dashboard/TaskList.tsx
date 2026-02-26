import { TaskRow, type TaskData } from "./TaskRow";

interface TaskListProps {
  tasks: TaskData[];
  selectedTaskId: string | null;
  focusedIndex: number;
  onSelect: (taskId: string) => void;
}

export function TaskList({ tasks, selectedTaskId, focusedIndex, onSelect }: TaskListProps) {
  if (tasks.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-4 text-center">
        <p className="text-[13px] text-text-faint">No tasks yet. Type a prompt above to create one.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {tasks.map((task, i) => (
        <TaskRow
          key={task.task_id}
          task={task}
          selected={task.task_id === selectedTaskId}
          focused={i === focusedIndex && task.task_id !== selectedTaskId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
