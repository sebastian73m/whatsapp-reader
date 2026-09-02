const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function assertCalendarDate(value: string): [number, number, number] {
  const match = DATE_ONLY.exec(value);
  if (!match) throw new Error(`Fecha inválida: ${value}. Use ISO-8601.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error(`Fecha calendario inválida: ${value}`);
  }
  return [year, month, day];
}

function partsAt(timestamp: number, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
}

function zonedMidnight(year: number, month: number, day: number, timeZone: string): number {
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  for (let i = 0; i < 4; i += 1) {
    const p = partsAt(guess, timeZone);
    const represented = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
    const next = guess + (target - represented);
    if (next === guess) return next;
    guess = next;
  }
  return guess;
}

function nextCalendarDay(year: number, month: number, day: number): [number, number, number] {
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return [next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()];
}

function parseDateTime(value: string): number {
  if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) {
    throw new Error(`Fecha-hora inválida: ${value}. Incluya Z o un offset, por ejemplo 2026-09-02T15:30:00-03:00.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Fecha ISO-8601 inválida: ${value}`);
  return parsed;
}

export function parseRange(
  fromDate: string | undefined,
  toDate: string | undefined,
  timeZone: string,
): { fromMs?: number; toExclusiveMs?: number } {
  let fromMs: number | undefined;
  let toExclusiveMs: number | undefined;
  if (fromDate) {
    const match = DATE_ONLY.exec(fromDate);
    if (match) {
      const [year, month, day] = assertCalendarDate(fromDate);
      fromMs = zonedMidnight(year, month, day, timeZone);
    } else {
      fromMs = parseDateTime(fromDate);
    }
  }
  if (toDate) {
    const match = DATE_ONLY.exec(toDate);
    if (match) {
      const [year, month, day] = assertCalendarDate(toDate);
      const [nextYear, nextMonth, nextDay] = nextCalendarDay(year, month, day);
      toExclusiveMs = zonedMidnight(nextYear, nextMonth, nextDay, timeZone);
    } else {
      toExclusiveMs = parseDateTime(toDate) + 1;
    }
  }
  if (fromMs !== undefined && toExclusiveMs !== undefined && fromMs >= toExclusiveMs) {
    throw new Error("from_date debe ser anterior o igual a to_date");
  }
  return {
    ...(fromMs === undefined ? {} : { fromMs }),
    ...(toExclusiveMs === undefined ? {} : { toExclusiveMs }),
  };
}
