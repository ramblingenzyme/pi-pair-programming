
import { SessionStore } from "../store/session-store.ts";

export const TODOS_ENTRY = "pair-todos";

export interface Todo {
  text: string;
  done: boolean;
}

export interface TodoState {
  todos: Todo[];
}

export function addTodo(state: TodoState, text: string): { state: TodoState; added: Todo } {
  const todo: Todo = { text, done: false };
  return {
    state: { todos: [...state.todos, todo] },
    added: todo,
  };
}

export function toggleTodo(
  state: TodoState,
  index: number,
): { state: TodoState; toggled: Todo | undefined } {
  const todo = state.todos[index];
  if (!todo) return { state, toggled: undefined };
  const updated = state.todos.map((t, i) => (i === index ? { ...t, done: !t.done } : t));
  return { state: { ...state, todos: updated }, toggled: { ...todo, done: !todo.done } };
}

export function removeTodo(
  state: TodoState,
  index: number,
): { state: TodoState; removed: Todo | undefined } {
  const todo = state.todos[index];
  if (!todo) return { state, removed: undefined };
  return { state: { ...state, todos: state.todos.filter((_, i) => i !== index) }, removed: todo };
}

/**
 * Manages todo state with session persistence.
 * Reconstructs from session on start, persists after every change.
 */
export class TodoStore extends SessionStore<TodoState> {
  constructor() {
    super(TODOS_ENTRY, () => ({ todos: [] }));
  }

  add(text: string): Todo {
    const { state, added } = addTodo(this.getState(), text);
    this.setState(state);
    return added;
  }

  toggle(index: number): Todo | undefined {
    const { state, toggled } = toggleTodo(this.getState(), index);
    this.setState(state);
    return toggled;
  }

  remove(index: number): Todo | undefined {
    const { state, removed } = removeTodo(this.getState(), index);
    this.setState(state);
    return removed;
  }

  pendingCount(): number {
    return this.getState().todos.filter((t) => !t.done).length;
  }
}
