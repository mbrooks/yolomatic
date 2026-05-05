export class TaskController {
	private readonly active = new Map<string, () => void>();

	register(key: string, abort: () => void): void {
		this.active.set(key, abort);
	}

	unregister(key: string): void {
		this.active.delete(key);
	}

	cancel(key: string): boolean {
		const abort = this.active.get(key);
		if (abort) {
			abort();
			this.active.delete(key);
			return true;
		}
		return false;
	}

	isActive(key: string): boolean {
		return this.active.has(key);
	}
}
