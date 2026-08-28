import { COMPLETE, observed, unmeasurable } from "../signal.js";
//#region server/collect/cloud/collector.ts
const VOLUME_SIGNAL = "cloud:storage.volume";
const CLOUD_SIGNALS = [VOLUME_SIGNAL];
var CloudCollector = class {
	options;
	surface = "cloud";
	name = "object-storage";
	signals = CLOUD_SIGNALS;
	calls = 0;
	constructor(options = {}) {
		this.options = options;
	}
	spent() {
		return {
			surface: this.surface,
			name: this.name,
			calls: this.calls
		};
	}
	async collect(ids, context) {
		const results = [];
		for (const id of ids) {
			if (id !== "cloud:storage.volume") {
				results.push(unmeasurable(id, `No cloud collector is implemented for ${id}.`));
				continue;
			}
			if (context.collected.has(id)) continue;
			const result = await this.volume(context);
			results.push(result);
			await context.settled?.(result);
		}
		return results;
	}
	async volume(context) {
		const credentials = await context.credentials.cloud();
		if (credentials == null) return unmeasurable(VOLUME_SIGNAL, "No Unity Catalog service credential is configured, so the cloud-side bill is not read. The Delta-log sample still reports active bytes.");
		const read = this.options.readVolume;
		if (read == null) return unmeasurable(VOLUME_SIGNAL, "A service credential is configured but this build has no Storage Lens or CloudWatch reader yet, so the cloud-side bill is not read.");
		this.calls += 1;
		const started = Date.now();
		try {
			const volume = await read(credentials);
			return observed(VOLUME_SIGNAL, volume, Date.now() - started, COMPLETE);
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : "the cloud reader failed";
			return unmeasurable(VOLUME_SIGNAL, `The cloud-side bill could not be read: ${reason}.`);
		}
	}
};
//#endregion
export { CLOUD_SIGNALS, CloudCollector, VOLUME_SIGNAL };
