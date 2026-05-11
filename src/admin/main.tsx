import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";

import "./styles.css";

const rootEl = typeof document !== "undefined" ? document.getElementById("root") : null;
if (rootEl) {
	createRoot(rootEl).render(
		<React.StrictMode>
			<App />
		</React.StrictMode>,
	);
}
