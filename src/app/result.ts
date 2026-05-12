export type AppErrorCode = "not_found" | "invalid_state" | "unauthorized" | "conflict" | "internal";

export interface AppSuccess<T> {
	success: true;
	data: T;
}

export interface AppFailure {
	success: false;
	code: AppErrorCode;
	message: string;
}

export type AppResult<T> = AppSuccess<T> | AppFailure;

export function ok<T>(data: T): AppSuccess<T> {
	return { success: true, data };
}

export function fail(code: AppErrorCode, message: string): AppFailure {
	return { success: false, code, message };
}
