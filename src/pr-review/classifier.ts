export const ACTIONABLE_KEYWORDS = [
	"fix",
	"change",
	"update",
	"add",
	"remove",
	"refactor",
	"nit:",
	"please",
	"should",
	"need",
	"needs",
	"can you",
	"could you",
];

export const NON_ACTIONABLE_KEYWORDS = [
	"lgtm",
	"looks good",
	"thanks",
	"thank you",
	"question:",
	"great",
	"awesome",
	"nice work",
	"well done",
	"nice",
];

export function classifyComment(body: string): "actionable" | "discussion" {
	const lower = body.toLowerCase();

	for (const keyword of ACTIONABLE_KEYWORDS) {
		if (lower.includes(keyword)) {
			return "actionable";
		}
	}

	for (const keyword of NON_ACTIONABLE_KEYWORDS) {
		if (lower.includes(keyword)) {
			return "discussion";
		}
	}

	return "actionable"; // default per spec: better to over-respond
}

export function classifyComments(comments: string[]): "actionable" | "discussion" {
	for (const comment of comments) {
		if (classifyComment(comment) === "actionable") {
			return "actionable";
		}
	}
	return "discussion";
}
