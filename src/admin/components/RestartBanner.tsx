import React from "react";

export function RestartBanner({
	children = "Yeetomatic is marked for restart. Maintenance mode active.",
}: {
	children?: React.ReactNode;
}): React.ReactElement {
	return (
		<div
			className="flex shrink-0 items-center gap-2 rounded-md border border-yellow bg-[rgba(210,153,34,0.15)] px-3 py-2.5 text-sm font-medium text-yellow"
			role="alert"
		>
			<span aria-hidden="true" className="text-base leading-none">
				&#x26A0;
			</span>
			<span className="leading-[1.4]">{children}</span>
		</div>
	);
}
