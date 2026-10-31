export const initialTasks = [
  { id: "task-filter", title: "Review the task filter", completed: false },
  { id: "keyboard", title: "Check keyboard navigation", completed: true },
  { id: "release-notes", title: "Write release notes", completed: false },
];

export const toggleTask = (tasks, id) =>
  tasks.map((task) => (task.id === id ? { ...task, completed: !task.completed } : task));
