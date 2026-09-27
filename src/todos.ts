import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const TODOS_ENTRY = "pair-todos";

export interface Todo {
	text: string;
	done: boolean;
}

export interface TodoState {
	todos: Todo[];
}

const empty: TodoState = { todos: [] };

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
	const todo: Todo = { text, done: false };
	return {
		state: { todos: [...state.todos, todo] },
		added: todo,
	};
}

export function toggleTodo(state: TodoState, index: number): { state: TodoState; toggled: Todo | undefined } {
	const todo = state.todos[index];
	if (!todo) return { state, toggled: undefined };
	const updated = state.todos.map((t, i) => (i === index ? { ...t, done: !t.done } : t));
	return { state: { ...state, todos: updated }, toggled: { ...todo, done: !todo.done } };
}

export function removeTodo(state: TodoState, index: number): { state: TodoState; removed: Todo | undefined } {
	const todo = state.todos[index];
	if (!todo) return { state, removed: undefined };
	return { state: { ...state, todos: state.todos.filter((_, i) => i !== index) }, removed: todo };
}

export function clearTodos(state: TodoState): TodoState {
	return { todos: [] };
}

/**
 * Manages todo state with session persistence.
 * Reconstructs from session on start, persists after every change.
 */
export class TodoStore {
	private state: TodoState = { todos: [] };
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

	toggle(index: number): Todo | undefined {
		const { state, toggled } = toggleTodo(this.state, index);
		this.state = state;
		this.persist();
		return toggled;
	}

	remove(index: number): Todo | undefined {
		const { state, removed } = removeTodo(this.state, index);
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
