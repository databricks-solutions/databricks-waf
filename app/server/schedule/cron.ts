// Reading a Quartz schedule well enough to say when the next assessment is due, or refusing to.
//
// The app needs two sentences from a cron expression: what the cadence is, in words a reader can
// check against what they think they configured, and when the next run falls. Neither is available
// from the Jobs API — a job carries its expression and its run history, and nothing that says "next".
//
// So it is computed here, for a deliberately small set of shapes, and **not guessed for the rest**.
// The expressions this covers are the ones a schedule for this product is actually written in: every
// day at a time, certain weekdays at a time, a day of the month at a time. Anything with a step, a
// range, a list of hours, a `L` or a `#` returns undefined, and the surface then shows the raw
// expression and says it cannot read it.
//
// That refusal is the whole reason this file is small. A cron library would parse all of it, and the
// failure mode of the wrong answer here is specific and bad: a next-review date is the one figure on
// the page a reader plans around, and one that is quietly a week out is worse than one that is
// absent. Sixty lines that are right about the common shapes and honest about the rest beat a
// dependency that is right about all of them and can only be trusted as far as its own tests.
//
// Quartz, not Unix cron, because that is what the Jobs API takes: six or seven fields rather than
// five, seconds leading, and a day-of-month/day-of-week pair where exactly one is `?`.

/** Sunday first, matching Quartz's own numbering, where 1 is Sunday and 7 is Saturday. */
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** A schedule this file was able to read. */
export interface Cadence {
  /** Second, minute and hour, all fixed: a schedule that fires at several times of day is refused. */
  readonly second: number;
  readonly minute: number;
  readonly hour: number;
  /** Weekdays it fires on, Sunday 0. Every day where the expression said so. */
  readonly days: readonly number[];
  /** Day of the month, where the expression named one instead of weekdays. */
  readonly dayOfMonth?: number;
}

/**
 * A Quartz expression as a cadence, or undefined where this file will not claim to have read it.
 *
 * Undefined covers three different things, and the caller treats them the same on purpose: an
 * expression using syntax not handled here, an expression that is malformed, and an expression with
 * the wrong number of fields. All three mean the same thing to a reader — the app cannot tell them
 * when the next run is — and distinguishing them would produce three sentences that end in the same
 * place.
 */
export function readCadence(expression: string): Cadence | undefined {
  const fields = expression.trim().split(/\s+/);
  // Six fields, or seven with a year. The year is accepted and ignored: it bounds the schedule's
  // lifetime rather than its cadence, and a schedule that has expired has no next run — which shows
  // as a run history that stops rather than as a cadence this file got wrong.
  if (fields.length !== 6 && fields.length !== 7) return undefined;

  const [second, minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  const at = [second, minute, hour].map(fixed);
  if (at.some((value) => value == null)) return undefined;
  const [seconds, minutes, hours] = at as [number, number, number];
  if (seconds > 59 || minutes > 59 || hours > 23) return undefined;

  // Only every month. A schedule that fires in some months and not others is a cadence this file
  // would have to describe in a clause it has no words for.
  if (month !== '*' && month !== '?') return undefined;

  const monthly = fixed(dayOfMonth);
  if (monthly != null) {
    // A day of the month, so the weekday field must be the one standing aside.
    if (dayOfWeek !== '?' && dayOfWeek !== '*') return undefined;
    if (monthly < 1 || monthly > 31) return undefined;
    return { second: seconds, minute: minutes, hour: hours, days: [], dayOfMonth: monthly };
  }

  if (dayOfMonth !== '*' && dayOfMonth !== '?') return undefined;

  const days = readDays(dayOfWeek);
  if (days == null) return undefined;

  return { second: seconds, minute: minutes, hour: hours, days };
}

/** Every day, or a comma-separated list of names or Quartz numbers. Ranges and steps are refused. */
function readDays(field: string): readonly number[] | undefined {
  if (field === '*' || field === '?') return [0, 1, 2, 3, 4, 5, 6];

  const days: number[] = [];
  for (const part of field.split(',')) {
    const name = part.trim().toUpperCase();
    const named = DAYS.indexOf(name as (typeof DAYS)[number]);
    if (named >= 0) {
      days.push(named);
      continue;
    }

    // Quartz numbers days 1 (Sunday) to 7 (Saturday). Zero is accepted as Sunday too, because it is
    // what a reader who knows Unix cron writes and the Jobs API accepts it.
    const number = fixed(name);
    if (number == null || number > 7) return undefined;
    days.push(number === 0 ? 0 : number - 1);
  }

  if (days.length === 0) return undefined;
  return [...new Set(days)].sort((a, b) => a - b);
}

/** A field naming exactly one value, or undefined for `*`, `?`, a range, a step or a list. */
function fixed(field: string): number | undefined {
  if (!/^\d{1,2}$/.test(field)) return undefined;
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
export function describeCadence(cadence: Cadence, timezone: string): string {
  const at = `${pad(cadence.hour)}:${pad(cadence.minute)} ${timezone}`;

  if (cadence.dayOfMonth != null) {
    return `Every month on the ${ordinal(cadence.dayOfMonth)} at ${at}`;
  }

  if (cadence.days.length === 7) return `Every day at ${at}`;

  const names = cadence.days.map((day) => DAY_NAMES[day] ?? '');
  if (names.length === 1) return `Every ${names[0] ?? ''} at ${at}`;

  const last = names.pop() ?? '';
  return `Every ${names.join(', ')} and ${last} at ${at}`;
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
export function nextRun(cadence: Cadence, timezone: string, from: Date): Date | undefined {
  const LIMIT = 400;

  for (let day = 0; day <= LIMIT; day += 1) {
    const candidate = firingOn(cadence, timezone, new Date(from.getTime() + day * 86_400_000));
    if (candidate != null && candidate.getTime() > from.getTime()) return candidate;
  }

  return undefined;
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
function firingOn(cadence: Cadence, timezone: string, probe: Date): Date | undefined {
  const local = localParts(timezone, probe);
  if (local == null) return undefined;

  if (cadence.dayOfMonth != null) {
    if (local.day !== cadence.dayOfMonth) return undefined;
  } else if (!cadence.days.includes(local.weekday)) {
    return undefined;
  }

  const guess = Date.UTC(local.year, local.month - 1, local.day, cadence.hour, cadence.minute, cadence.second);
  const offset = offsetAt(timezone, new Date(guess));
  if (offset == null) return undefined;

  return new Date(guess - offset);
}

interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekday: number;
}

function localParts(timezone: string, instant: Date): LocalParts | undefined {
  const parts = format(timezone, instant);
  if (parts == null) return undefined;

  const weekday = DAYS.indexOf((parts.weekday ?? '').slice(0, 3).toUpperCase() as (typeof DAYS)[number]);
  if (weekday < 0) return undefined;

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday,
  };
}

/** How far the zone is ahead of UTC at this instant, in milliseconds. */
function offsetAt(timezone: string, instant: Date): number | undefined {
  const parts = format(timezone, instant);
  if (parts == null) return undefined;

  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );

  return asUtc - instant.getTime();
}

type Formatted = Record<string, string>;

/**
 * The wall-clock parts of an instant in a zone, or undefined where the zone is not one.
 *
 * A job's `timezone_id` is a string a person typed, so an unknown zone is a real input rather than a
 * defensive branch — and it must not throw here, because the caller's job is to report a schedule it
 * could not read, not to fail the request that asked for it.
 */
function format(timezone: string, instant: Date): Formatted | undefined {
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

    return Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  } catch {
    return undefined;
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function ordinal(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${String(value)}th`;

  const suffix = ['th', 'st', 'nd', 'rd'][value % 10] ?? 'th';
  return `${String(value)}${value % 10 <= 3 ? suffix : 'th'}`;
}
