import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import { OnboardingWizard } from "./features/onboarding/OnboardingWizard.js";
import { fetchOnboardingStatus } from "./api/onboarding.js";
import "./index.css";

function Root(): React.ReactElement {
	const [onboarding, setOnboarding] = useState<{ complete: boolean; missing: string[] } | null>(null);

	useEffect(() => {
		fetchOnboardingStatus()
			.then((data) => setOnboarding(data))
			.catch(() => setOnboarding({ complete: true, missing: [] }));
	}, []);

	if (onboarding === null) {
		return <div className="empty">Loading...</div>;
	}

	if (!onboarding.complete) {
		return <OnboardingWizard />;
	}

	return <App />;
}

const rootEl = typeof document !== "undefined" ? document.getElementById("root") : null;
if (rootEl) {
	createRoot(rootEl).render(
		<React.StrictMode>
			<Root />
		</React.StrictMode>,
	);
}
