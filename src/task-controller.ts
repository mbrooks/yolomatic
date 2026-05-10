export class TaskController {
	private readonly active = new Map<string, { abort: () => void; steer?: (msg: string) => Promise<void> }>();

	register(key: string, abort: () => void, steer?: (msg: string) => Promise<void>): void {
		this.active.set(key, { abort, steer });
	}

	unregister(key: string): void {
		this.active.delete(key);
	}

	cancel(key: string): boolean {
		const task = this.active.get(key);
		if (task) {
			task.abort();
			this.active.delete(key);
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
}
