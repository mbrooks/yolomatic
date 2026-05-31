export interface Clock {
	now(): Date;
	uptime(): number;
}

export const systemClock: Clock = {
	now: () => new Date(),
	uptime: () => process.uptime(),
};
