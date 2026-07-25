export type TaskRegistration = symbol;

export interface TaskControlService {
	cancel(key: string): boolean;
	isActive(key: string): boolean;
	steer(key: string, message: string): Promise<boolean>;
	register(key: string, abort: () => void, steer?: (msg: string) => Promise<void>): TaskRegistration | null;
	unregister(key: string, registration?: TaskRegistration): void;
	isDraining(): boolean;
	setDraining(value: boolean): void;
}
