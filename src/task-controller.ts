import type { TaskControlService, TaskRegistration } from "./ports/task-control-service.js";

export class TaskController implements TaskControlService {
	private readonly active = new Map<
		string,
		{ registration: TaskRegistration; abort: () => void; steer?: (msg: string) => Promise<void> }
	>();
	private draining = false;

	register(key: string, abort: () => void, steer?: (msg: string) => Promise<void>): TaskRegistration | null {
		if (this.active.has(key)) {
			return null;
		}
		const registration = Symbol(key);
		this.active.set(key, { registration, abort, steer });
		return registration;
	}

	unregister(key: string, registration?: TaskRegistration): void {
		if (registration && this.active.get(key)?.registration !== registration) {
			return;
		}
		this.active.delete(key);
	}

	cancel(key: string): boolean {
		const task = this.active.get(key);
		if (task) {
			task.abort();
			// Intentionally do NOT delete the key here. The in-flight
			// ExecuteSession.run owns this key until its `finally` block calls
			// unregister. Releasing the key before the run winds down opens a
			// window in which a concurrent event (redelivered webhook, feedback
			// or mention comment) observes isActive(key) === false and starts a
			// new worker, undoing the Stop.
			return true;
		}
		return false;
	}

	isActive(key: string): boolean {
		return this.active.has(key);
	}

	async steer(key: string, message: string): Promise<boolean> {
		const task = this.active.get(key);
		if (task?.steer) {
			try {
				await task.steer(message);
				return true;
			} catch {
				return false;
			}
		}
		return false;
	}

	setDraining(value: boolean): void {
		this.draining = value;
	}

	isDraining(): boolean {
		return this.draining;
	}
}
