//#region server/store/revisions.ts
async function newestReadable(reads, revive) {
	const records = [];
	const failed = [];
	for (const row of await reads.newest()) {
		const record = revive(row.body);
		if (record == null) failed.push(row.id);
		else records.push(record);
	}
	if (failed.length === 0) return {
		records,
		unreadable: 0
	};
	let unreadable = 0;
	const settled = /* @__PURE__ */ new Set();
	for (const row of await reads.history(failed)) {
		if (settled.has(row.id)) continue;
		const record = revive(row.body);
		if (record == null) {
			unreadable += 1;
			continue;
		}
		settled.add(row.id);
		records.push(record);
	}
	return {
		records,
		unreadable
	};
}
//#endregion
export { newestReadable };
