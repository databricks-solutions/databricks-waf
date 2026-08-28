//#region server/collect/provenance.ts
/**
* The place a surface reads from, or nothing when it was not supplied.
*
* `sql` and `describe` both run statements on the bound warehouse; they are separate surfaces
* because they scale differently against it, not because they run in different places. `cloud` is
* absent on purpose: the collector that reads it knows its own bucket, and a guess made here would
* be the one field in this record that could not be checked.
*/
function locate(surface, locations) {
	if (surface === "sql" || surface === "describe") return locations.warehouse == null ? void 0 : `warehouse ${locations.warehouse}`;
	if (surface === "rest" || surface === "plans") return locations.host;
}
/**
* A reading with its origin recorded, unless it already recorded its own.
*
* The precedence is what makes this extensible without a second mechanism. A collector that knows
* something the scan cannot — the cloud collector, reading object storage under a service
* credential rather than under the identity running the scan — sets `provenance` on the result it
* returns and this leaves it alone. Everything else is stamped centrally, so no collector has to
* remember, and a collector added later cannot produce unattributed readings by omission.
*/
function attributed(result, provenance) {
	return result.provenance != null ? result : {
		...result,
		provenance
	};
}
//#endregion
export { attributed, locate };
