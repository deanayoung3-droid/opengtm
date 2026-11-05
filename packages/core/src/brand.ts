/**
 * The product name shown in the dashboard, alert emails and page titles. Set APP_NAME in .env to rename
 * your install (for example "Acme Outbound"); the default is the project's name.
 */
export const APP_NAME = process.env.APP_NAME?.trim() || "OpenGTM";
