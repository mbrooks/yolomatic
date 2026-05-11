import type { TaskControlService } from "../../ports/task-control-service.js";
import type { TaskController } from "../../task-controller.js";

export class TaskControlServiceAdapter implements TaskControlService {
	constructor(private readonly controller: TaskController) {}

	cancel(key: string): boolean {
		return this.controller.cancel(key);
	}

	isActive(key: string): boolean {
		return this.controller.isActive(key);
	}

	steer(key: string, message: string): Promise<boolean> {
		return this.controller.steer(key, message);
	}

	register(key: string, abort: () => void, steer?: (msg: string) => Promise<void>): void {
		this.controller.register(key, abort, steer);
	}

	unregister(key: string): void {
		this.controller.unregister(key);
	}

	isDraining(): boolean {
		return this.controller.isDraining();
	}

	setDraining(value: boolean): void {
		this.controller.setDraining(value);
	}
}
