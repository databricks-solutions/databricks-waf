import { createServer } from "node:http";
//#region server/api/fallback.ts
/** A file or module the app ships is not where it should be: a packaging fault, not a configuration one. */
const INCOMPLETE_INSTALL = /ENOENT|no such file or directory|Cannot find (?:module|package)|MODULE_NOT_FOUND|config[/\\]controls/i;
/**
* The likely cause, in the words of someone who has to fix it.
*
* Pattern-matched on the message because AppKit's startup errors are not a typed
* hierarchy. A match produces a specific instruction; no match falls through to the
* original message, which is still better than an exited process.
*/
function explain(cause) {
	const detail = cause instanceof Error ? cause.message : String(cause);
	const lower = detail.toLowerCase();
	if (INCOMPLETE_INSTALL.test(detail)) return {
		kind: "app-incomplete",
		summary: "This installation of the app is missing part of itself.",
		action: "No workspace setting will fix this: a file or module the app ships is absent from the deployed tree. Reinstall or redeploy the app. If it persists, it is a fault in the released package rather than in this workspace, and worth reporting with the detail below.",
		detail
	};
	if (detail.includes("WAF_ASSESSOR_GROUP")) return {
		kind: "no-assessor-group",
		summary: "This app does not know who is allowed to change an assessment.",
		action: "Set `assessor_group` in databricks.yml to the name of a Databricks group in this workspace, then redeploy. Its members may start scans, answer the requirements only a person can answer, and accept or defer a risk; everyone else can still read everything. The group has to hold its members directly, because a group nested inside another is not reported as a membership. Unlike a missing resource, this one is not fixable from the workspace UI and the retry below will not clear it.",
		detail
	};
	if (lower.includes("lakebase") || lower.includes("postgres")) return {
		kind: "no-database",
		summary: "This app has no Lakebase database bound to it.",
		action: "Open the app in your workspace, choose Edit, and add a database resource with CAN_CONNECT_AND_CREATE. The app keeps scan history, attested answers and risk decisions there, so it will not start without one. If a database is already bound, the app service principal needs CAN_CONNECT_AND_CREATE on it rather than read-only access: the app creates its own schema on first boot.",
		detail
	};
	if (lower.includes("warehouse")) return {
		kind: "no-warehouse",
		summary: "This app has no SQL warehouse bound to it.",
		action: "Open the app in your workspace, choose Edit, and add a SQL warehouse resource with CAN USE permission. The assessment reads Unity Catalog system tables through that warehouse, so it cannot run without one. A serverless warehouse on the smallest size is sufficient.",
		detail
	};
	if (lower.includes("permission") || lower.includes("403") || lower.includes("forbidden")) return {
		kind: "permission",
		summary: "The app service principal is missing a permission it needs to start.",
		action: "Grant the app service principal CAN USE on the bound SQL warehouse. The app then reads system tables as whoever started the run, not as itself, so no further data grants are needed for the service principal.",
		detail
	};
	return {
		kind: "unknown",
		summary: "The app could not start.",
		action: "The underlying error is shown below. The most common cause is a resource declared by the app but not bound to it at install time; check the app’s resources in the workspace UI.",
		detail
	};
}
function page(cause) {
	const { summary, action, detail } = explain(cause);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Setup needed</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; padding: 3rem 1.5rem; background: #f7f7f8; color: #1b1b1f; }
  main { max-width: 46rem; margin: 0 auto; background: #fff; border: 1px solid #e3e3e7; border-radius: 12px; padding: 2rem; }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; }
  pre { background: #f2f2f4; padding: 1rem; border-radius: 8px; overflow-x: auto; font-size: 0.85rem; }
  .muted { color: #5a5a63; font-size: 0.9rem; }
</style>
</head>
<body>
<main>
  <h1>${escapeHtml(summary)}</h1>
  <p>${escapeHtml(action)}</p>
  <p class="muted">This page is retrying in the background. Once the resource is bound, the app starts on its own \u2014 no redeploy needed.</p>
  <pre>${escapeHtml(detail)}</pre>
</main>
</body>
</html>`;
}
function escapeHtml(value) {
	return value.replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		"\"": "&quot;",
		"'": "&#39;"
	})[character] ?? character);
}
/**
* Serves the explanation on every path and keeps retrying the real startup.
*
* Every path, including the API routes, because a client that has the page cached will
* call `/api/scans` first and a 404 there would read as an empty app rather than an
* unconfigured one. The status is 503 so monitoring sees a service that is not ready,
* rather than one that is fine and happens to be useless.
*/
function startFallbackServer(cause, options = {}) {
	const port = options.port ?? Number(process.env.DATABRICKS_APP_PORT ?? process.env.PORT ?? 8e3);
	const body = page(cause);
	const { kind, summary, action, detail } = explain(cause);
	const server = createServer((request, response) => {
		const wantsJson = request.url?.startsWith("/api/") === true;
		response.writeHead(503, {
			"content-type": wantsJson ? "application/json" : "text/html; charset=utf-8",
			"retry-after": "30"
		});
		response.end(wantsJson ? JSON.stringify({
			error: "not-configured",
			kind,
			summary,
			action,
			detail
		}) : body);
	});
	server.listen(port, () => {
		console.error(`[startup] ${summary} Serving an explanation on port ${String(port)} and retrying.`);
	});
	const handle = {
		server,
		close: () => new Promise((resolve, reject) => {
			server.close((error) => error != null ? reject(error) : resolve());
		})
	};
	if (options.retry != null) scheduleRetry(handle, options.retry, options.retryIntervalMs ?? 3e4);
	return handle;
}
function scheduleRetry(handle, retry, intervalMs) {
	setTimeout(() => {
		handle.close().then(retry).catch((cause) => {
			console.error("[startup] Retry failed; continuing to serve the explanation.", cause);
			startFallbackServer(cause, {
				retry,
				retryIntervalMs: intervalMs
			});
		});
	}, intervalMs).unref();
}
//#endregion
export { explain, startFallbackServer };
