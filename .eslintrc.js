module.exports = {
	parser: "@typescript-eslint/parser",
	plugins: ["@typescript-eslint"],
	extends: [
		"eslint:recommended",
		"plugin:@typescript-eslint/recommended",
		"plugin:prettier/recommended",
	],
	env: {
		node: true,
		es2021: true,
	},
	parserOptions: {
		ecmaVersion: 2021,
		sourceType: "module",
	},
	rules: {
		"no-unused-vars": "off", // Disable base rule as it can conflict with TS rule
		"@typescript-eslint/no-unused-vars": [
			"warn",
			{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
		],
		"@typescript-eslint/explicit-module-boundary-types": "off",
		"@typescript-eslint/no-explicit-any": "warn",
	},
};
