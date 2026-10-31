import { initialTasks, toggleTask } from "./tasks.js";

let tasks = initialTasks;
const list = document.querySelector("#tasks");

const render = () => {
  list.replaceChildren(
    ...tasks.map((task) => {
      const item = document.createElement("li");
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = task.completed;
      checkbox.addEventListener("change", () => {
        tasks = toggleTask(tasks, task.id);
        render();
      });
      label.append(checkbox, document.createTextNode(task.title));
      item.append(label);
      return item;
    }),
  );
};

render();
