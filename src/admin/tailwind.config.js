export default {
	content: ["./index.html", "./**/*.{ts,tsx}"],
	theme: {
		extend: {
			colors: {
				bg: "var(--bg)",
				surface: "var(--surface)",
				border: "var(--border)",
				text: "var(--text)",
				muted: "var(--muted)",
				green: "var(--green)",
				yellow: "var(--yellow)",
				red: "var(--red)",
				blue: "var(--blue)",
			},
			fontFamily: {
				sans: ['-apple-system', "BlinkMacSystemFont", '"Segoe UI"', "Helvetica", "Arial", "sans-serif"],
			},
		},
	},
};
