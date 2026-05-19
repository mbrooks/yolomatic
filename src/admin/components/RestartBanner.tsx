import React from "react";

export function RestartBanner(): React.ReactElement {
	return (
		<div className="restart-banner" role="alert">
			<span className="restart-banner-icon">&#x26A0;</span>
			<span className="restart-banner-text">TARS is marked for restart. Maintenance mode active.</span>
		</div>
	);
}
