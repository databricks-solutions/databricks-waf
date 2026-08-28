//#region server/api/contain.ts
/**
* The methods on an express application that take route handlers.
*
* `use` and `all` are here with the verbs because middleware faults are handler faults — the app's
* `nosniff` middleware and its error middleware both arrive through `use`. `head` and `options` are
* here because express registers them, not because this app uses them today: a method left out is a
* registration path with no containment on it, and the omission would be invisible.
*/
const ROUTING_METHODS = [
	"use",
	"all",
	"get",
	"post",
	"put",
	"patch",
	"delete",
	"head",
	"options"
];
/** Whether a property name is one of the routing methods above. */
function isRoutingMethod(property) {
	return typeof property === "string" && ROUTING_METHODS.includes(property);
}
/**
* Run a handler and send anything it throws or rejects with to `next`.
*
* Both paths, because the two failures are not the same one. A synchronous throw is already caught
* by express 4 and would reach the error path without help; a rejection is not, and is the one that
* ends the process. Catching both means the wrapper does not have to know which kind of function it
* was given.
*/
function settle(call, next) {
	const forward = (cause) => {
		if (typeof next !== "function") throw cause;
		next(cause);
	};
	try {
		const result = call();
		if (result instanceof Promise) return result.catch(forward);
		return result;
	} catch (cause) {
		forward(cause);
		return;
	}
}
/**
* One handler, wrapped.
*
* The arity is preserved because express reads it: a function of four parameters is error
* middleware and anything else is a route handler, so a wrapper that normalised every handler to
* three parameters would silently stop the error middleware below from ever being called.
*/
function contain(handler) {
	if (handler.length >= 4) return function contained(error, request, response, next) {
		return settle(() => handler(error, request, response, next), next);
	};
	return function contained(request, response, next) {
		return settle(() => handler(request, response, next), next);
	};
}
/** A handler, an array of handlers, or something that is neither — a path, a regexp, a setting. */
function containArgument(argument) {
	if (typeof argument === "function") return contain(argument);
	if (Array.isArray(argument)) return argument.map(containArgument);
	return argument;
}
/**
* The same express application, with every handler registered through it contained.
*
* A proxy rather than 87 hand edits. The point is not brevity: a wrapper applied by hand is a thing
* the next handler can be added without, it works in every test, and it takes the app down once, in
* production, on an input nobody had. Applied here, a new route cannot opt out by being forgotten —
* and `check-contained-handlers.mjs` holds the two ways it could still be bypassed, which are a
* route module building its own `Router` and a second `server.extend` that skips this function.
*
* Non-routing members pass through untouched, including `app.get('etag')` reading a setting rather
* than registering a route — that call has no function argument, so there is nothing to wrap.
*/
function contained(app) {
	return new Proxy(app, { get(target, property) {
		const value = Reflect.get(target, property);
		if (typeof value !== "function" || !isRoutingMethod(property)) return value;
		const method = value;
		return function registerContained(...args) {
			return Reflect.apply(method, target, args.map(containArgument));
		};
	} });
}
//#endregion
export { ROUTING_METHODS, contained };
