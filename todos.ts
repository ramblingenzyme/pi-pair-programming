import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const TODOS_ENTRY = "pair-todos";

export interface Todo {
	id: number;
	text: string;
	done: boolean;
}

export interface TodoState {
	todos: Todo[];
	nextId: number;
}

const empty: TodoState = { todos: [], nextId: 1 };

/**
 * Reconstruct todo state from the last pair-todos entry on the current branch.
 * Branch-aware: branching gives the correct state for that point in history.
 */
export function reconstructState(ctx: ExtensionContext): TodoState {
	for (let i = ctx.sessionManager.getBranch().length - 1; i >= 0; i--) {
		const entry = ctx.sessionManager.getBranch()[i];
		if (entry.type === "custom" && entry.customType === TODOS_ENTRY) {
			const data = (entry as { data?: TodoState }).data;
			if (data) return data;
		}
	}
	return { ...empty, todos: [] };
}

export function addTodo(state: TodoState, text: string): { state: TodoState; added: Todo } {
	const todo: Todo = { id: state.nextId, text, done: false };
	return {
		state: { todos: [...state.todos, todo], nextId: state.nextId + 1 },
		added: todo,
	};
}

export function toggleTodo(state: TodoState, id: number): { state: TodoState; toggled: Todo | undefined } {
	const todo = state.todos.find((t) => t.id === id);
	if (!todo) return { state, toggled: undefined };
	const updated = state.todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
	return { state: { ...state, todos: updated }, toggled: { ...todo, done: !todo.done } };
}

export function removeTodo(state: TodoState, id: number): { state: TodoState; removed: Todo | undefined } {
	const todo = state.todos.find((t) => t.id === id);
	if (!todo) return { state, removed: undefined };
	return { state: { ...state, todos: state.todos.filter((t) => t.id !== id) }, removed: todo };
}

export function clearTodos(state: TodoState): TodoState {
	return { todos: [], nextId: 1 };
}

/**
 * Manages todo state with session persistence.
 * Reconstructs from session on start, persists after every change.
 */
export class TodoStore {
	private state: TodoState = { todos: [], nextId: 1 };
	private pi: ExtensionAPI | undefined;

	load(ctx: ExtensionContext): void {
		this.state = reconstructState(ctx);
	}

	attach(pi: ExtensionAPI): void {
		this.pi = pi;
	}

	getState(): TodoState {
		return this.state;
	}

	add(text: string): Todo {
		const { state, added } = addTodo(this.state, text);
		this.state = state;
		this.persist();
		return added;
	}

	toggle(id: number): Todo | undefined {
		const { state, toggled } = toggleTodo(this.state, id);
		this.state = state;
		this.persist();
		return toggled;
	}

	remove(id: number): Todo | undefined {
		const { state, removed } = removeTodo(this.state, id);
		this.state = state;
		this.persist();
		return removed;
	}

	clear(): void {
		this.state = clearTodos(this.state);
		this.persist();
	}

	pendingCount(): number {
		return this.state.todos.filter((t) => !t.done).length;
	}

	private persist(): void {
		this.pi?.appendEntry(TODOS_ENTRY, this.state);
	}
}
