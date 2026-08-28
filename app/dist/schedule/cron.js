//#region server/schedule/cron.ts
/** Sunday first, matching Quartz's own numbering, where 1 is Sunday and 7 is Saturday. */
const DAYS = [
	"SUN",
	"MON",
	"TUE",
	"WED",
	"THU",
	"FRI",
	"SAT"
];
const DAY_NAMES = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday"
];
/**
* A Quartz expression as a cadence, or undefined where this file will not claim to have read it.
*
* Undefined covers three different things, and the caller treats them the same on purpose: an
* expression using syntax not handled here, an expression that is malformed, and an expression with
* the wrong number of fields. All three mean the same thing to a reader — the app cannot tell them
* when the next run is — and distinguishing them would produce three sentences that end in the same
* place.
*/
function readCadence(expression) {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 6 && fields.length !== 7) return void 0;
	const [second, minute, hour, dayOfMonth, month, dayOfWeek] = fields;
	const at = [
		second,
		minute,
		hour
	].map(fixed);
	if (at.some((value) => value == null)) return void 0;
	const [seconds, minutes, hours] = at;
	if (seconds > 59 || minutes > 59 || hours > 23) return void 0;
	if (month !== "*" && month !== "?") return void 0;
	const monthly = fixed(dayOfMonth);
	if (monthly != null) {
		if (dayOfWeek !== "?" && dayOfWeek !== "*") return void 0;
		if (monthly < 1 || monthly > 31) return void 0;
		return {
			second: seconds,
			minute: minutes,
			hour: hours,
			days: [],
			dayOfMonth: monthly
		};
	}
	if (dayOfMonth !== "*" && dayOfMonth !== "?") return void 0;
	const days = readDays(dayOfWeek);
	if (days == null) return void 0;
	return {
		second: seconds,
		minute: minutes,
		hour: hours,
		days
	};
}
/** Every day, or a comma-separated list of names or Quartz numbers. Ranges and steps are refused. */
function readDays(field) {
	if (field === "*" || field === "?") return [
		0,
		1,
		2,
		3,
		4,
		5,
		6
	];
	const days = [];
	for (const part of field.split(",")) {
		const name = part.trim().toUpperCase();
		const named = DAYS.indexOf(name);
		if (named >= 0) {
			days.push(named);
			continue;
		}
		const number = fixed(name);
		if (number == null || number > 7) return void 0;
		days.push(number === 0 ? 0 : number - 1);
	}
	if (days.length === 0) return void 0;
	return [...new Set(days)].sort((a, b) => a - b);
}
/** A field naming exactly one value, or undefined for `*`, `?`, a range, a step or a list. */
function fixed(field) {
	if (!/^\d{1,2}$/.test(field)) return void 0;
	return Number(field);
}
/**
* The cadence in words, for a reader checking it against what they meant to configure.
*
* The timezone is named rather than converted, because the job's schedule is stated in one and a
* reader in another needs to know which. "Every Monday at 06:00 UTC" is checkable; "every Monday at
* 16:00" on an Australian screen, from a job configured in UTC, is a sentence that reads correctly
* and sends somebody looking for a run that will not be there.
*/
function describeCadence(cadence, timezone) {
	const at = `${pad(cadence.hour)}:${pad(cadence.minute)} ${timezone}`;
	if (cadence.dayOfMonth != null) return `Every month on the ${ordinal(cadence.dayOfMonth)} at ${at}`;
	if (cadence.days.length === 7) return `Every day at ${at}`;
	const names = cadence.days.map((day) => DAY_NAMES[day] ?? "");
	if (names.length === 1) return `Every ${names[0] ?? ""} at ${at}`;
	const last = names.pop() ?? "";
	return `Every ${names.join(", ")} and ${last} at ${at}`;
}
/**
* The first firing strictly after `from`, in UTC.
*
* Walks days rather than solving for one, and the reason is the timezone. A schedule is stated in the
* job's zone, whose offset from UTC changes twice a year in most of them, so arithmetic on a UTC
* instant is wrong for half the year in any zone that observes daylight saving. Walking a day at a
* time and asking `Intl` what the local wall-clock time is on each is slower and does not have that
* class of bug.
*
* Bounded at 400 days so a schedule with no next firing — the 31st of a month, in a run of shorter
* months — terminates rather than spins. That bound is a year and a bit for a reason: every cadence
* this file reads fires at least once a year, so reaching it means the expression describes something
* this file thought it understood and did not, and undefined is the honest answer.
*/
function nextRun(cadence, timezone, from) {
	const LIMIT = 400;
	for (let day = 0; day <= LIMIT; day += 1) {
		const candidate = firingOn(cadence, timezone, new Date(from.getTime() + day * 864e5));
		if (candidate != null && candidate.getTime() > from.getTime()) return candidate;
	}
}
/**
* The instant this cadence fires on the local date containing `probe`, if it fires that day at all.
*
* The offset is measured at the candidate instant rather than assumed, which is what makes this
* correct across a daylight-saving boundary: the guess is built from the local date and the target
* wall-clock time, and then corrected once by the offset in force at the guess. A second correction
* is not needed — the offset is being read at an instant within an hour or two of the answer, and no
* zone changes offset twice inside that window.
*/
function firingOn(cadence, timezone, probe) {
	const local = localParts(timezone, probe);
	if (local == null) return void 0;
	if (cadence.dayOfMonth != null) {
		if (local.day !== cadence.dayOfMonth) return void 0;
	} else if (!cadence.days.includes(local.weekday)) return;
	const guess = Date.UTC(local.year, local.month - 1, local.day, cadence.hour, cadence.minute, cadence.second);
	const offset = offsetAt(timezone, new Date(guess));
	if (offset == null) return void 0;
	return new Date(guess - offset);
}
function localParts(timezone, instant) {
	const parts = format(timezone, instant);
	if (parts == null) return void 0;
	const weekday = DAYS.indexOf((parts.weekday ?? "").slice(0, 3).toUpperCase());
	if (weekday < 0) return void 0;
	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		weekday
	};
}
/** How far the zone is ahead of UTC at this instant, in milliseconds. */
function offsetAt(timezone, instant) {
	const parts = format(timezone, instant);
	if (parts == null) return void 0;
	return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)) - instant.getTime();
}
/**
* The wall-clock parts of an instant in a zone, or undefined where the zone is not one.
*
* A job's `timezone_id` is a string a person typed, so an unknown zone is a real input rather than a
* defensive branch — and it must not throw here, because the caller's job is to report a schedule it
* could not read, not to fail the request that asked for it.
*/
function format(timezone, instant) {
	try {
		const formatter = new Intl.DateTimeFormat("en-GB", {
			timeZone: timezone,
			hourCycle: "h23",
			weekday: "short",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit"
		});
		return Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
	} catch {
		return;
	}
}
function pad(value) {
	return String(value).padStart(2, "0");
}
function ordinal(value) {
	const tens = value % 100;
	if (tens >= 11 && tens <= 13) return `${String(value)}th`;
	const suffix = [
		"th",
		"st",
		"nd",
		"rd"
	][value % 10] ?? "th";
	return `${String(value)}${value % 10 <= 3 ? suffix : "th"}`;
}
//#endregion
export { describeCadence, nextRun, readCadence };
