import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../response-helpers.js";
import {
	AdminRouteRegistry,
	NotFoundError,
	ValidationError,
	getRequiredDeps,
	type AdminRouterDeps,
} from "../admin-router-shared.js";

function toUserView(user: {
	id: string;
	fullName: string;
	username: string;
	createdAt: string;
	updatedAt: string;
}) {
	return {
		id: user.id,
		fullName: user.fullName,
		username: user.username,
		createdAt: user.createdAt,
		updatedAt: user.updatedAt,
	};
}

const registry = new AdminRouteRegistry()
	.route({
		method: "GET",
		pattern: /^\/api\/users$/u,
		requiresDeps: ["userStore"],
		handler: async (ctx) => {
			const { userStore } = getRequiredDeps(ctx.deps, ["userStore"]);
			const users = userStore.listSync();
			return { status: 200, body: { users: users.map(toUserView) } };
		},
	})
	.route<{ full_name?: string; username?: string; password?: string }>({
		method: "POST",
		pattern: /^\/api\/users$/u,
		parseBody: true,
		required: ["full_name", "username", "password"],
		requiresDeps: ["userStore"],
		handler: async (ctx) => {
			const { userStore } = getRequiredDeps(ctx.deps, ["userStore"]);
			const body = ctx.body as { full_name: string; username: string; password: string };
			let user;
			try {
				user = userStore.createSync({
					fullName: body.full_name,
					username: body.username,
					password: body.password,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("already taken")) {
					sendJson(ctx.response, 409, { error: message });
					return;
				}
				throw new ValidationError(message);
			}
			return { status: 201, body: toUserView(user) };
		},
	})
	.route<{ full_name?: string }>({
		method: "PATCH",
		pattern: /^\/api\/users\/([^/]+)$/u,
		parseBody: true,
		requiresDeps: ["userStore"],
		handler: async (ctx) => {
			const { userStore } = getRequiredDeps(ctx.deps, ["userStore"]);
			const [id] = ctx.params;
			const body = ctx.body as { full_name?: string };
			if (body.full_name === undefined) {
				throw new ValidationError("full_name is required");
			}
			let updated;
			try {
				updated = userStore.updateFullNameSync(id, body.full_name);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new ValidationError(message);
			}
			if (!updated) {
				throw new NotFoundError("User not found");
			}
			return { status: 200, body: toUserView(updated) };
		},
	})
	.route<{ password?: string }>({
		method: "POST",
		pattern: /^\/api\/users\/([^/]+)\/password$/u,
		parseBody: true,
		required: ["password"],
		requiresDeps: ["userStore"],
		handler: async (ctx) => {
			const { userStore } = getRequiredDeps(ctx.deps, ["userStore"]);
			const [id] = ctx.params;
			const body = ctx.body as { password: string };
			let updated;
			try {
				updated = userStore.updatePasswordSync(id, body.password);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new ValidationError(message);
			}
			if (!updated) {
				throw new NotFoundError("User not found");
			}
			return { status: 200, body: toUserView(updated) };
		},
	})
	.route({
		method: "DELETE",
		pattern: /^\/api\/users\/([^/]+)$/u,
		requiresDeps: ["userStore"],
		handler: async (ctx) => {
			const { userStore } = getRequiredDeps(ctx.deps, ["userStore"]);
			const [id] = ctx.params;
			// Prevent locking out the last admin account: the onboarding trigger
			// relies on the users table being empty, and operators must always be
			// able to reach the dashboard.
			if (userStore.listSync().length <= 1) {
				sendJson(ctx.response, 409, {
					error: "Cannot delete the last admin user. Add another admin first.",
				});
				return;
			}
			const deleted = userStore.deleteSync(id);
			if (!deleted) {
				throw new NotFoundError("User not found");
			}
			return { status: 200, body: { deleted: true } };
		},
	});

export async function handleUserRoutes(
	request: IncomingMessage,
	response: ServerResponse,
	deps: AdminRouterDeps,
	pathname: string,
): Promise<boolean> {
	return registry.handle(request, response, deps, pathname);
}