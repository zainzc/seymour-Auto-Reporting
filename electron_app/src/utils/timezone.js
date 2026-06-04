const DEFAULT_TIME_ZONE = 'America/New_York';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toDate(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (value === null || value === undefined || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function getTimeZoneParts(date, timeZone = DEFAULT_TIME_ZONE) {
  const targetDate = toDate(date);
  if (!targetDate) return null;

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(targetDate);
  const lookup = {};
  parts.forEach(part => {
    if (part.type !== 'literal') {
      lookup[part.type] = part.value;
    }
  });

  return {
    weekday: lookup.weekday || '',
    monthNumber: lookup.month || '',
    day: lookup.day || '',
    year: lookup.year || '',
    hour: lookup.hour || '',
    minute: lookup.minute || '',
    second: lookup.second || ''
  };
}

function getTimeZoneDisplayName(date, timeZone = DEFAULT_TIME_ZONE) {
  const targetDate = toDate(date);
  if (!targetDate) return '';

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'long'
  });
  const parts = formatter.formatToParts(targetDate);
  const zone = parts.find(part => part.type === 'timeZoneName');
  return zone ? zone.value : '';
}

function getTimeZoneOffsetMinutes(date, timeZone = DEFAULT_TIME_ZONE) {
  const targetDate = toDate(date);
  if (!targetDate) return 0;

  const parts = getTimeZoneParts(targetDate, timeZone);
  if (!parts) return 0;

  const asUtc = Date.UTC(
    Number(parts.year || 0),
    Math.max(0, Number(parts.monthNumber || 1) - 1),
    Number(parts.day || 1),
    Number(parts.hour || 0),
    Number(parts.minute || 0),
    Number(parts.second || 0)
  );
  return Math.round((asUtc - targetDate.getTime()) / 60000);
}

function formatTimeZoneOffset(minutes = 0) {
  const totalMinutes = Math.abs(Number(minutes) || 0);
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
  const mins = String(totalMinutes % 60).padStart(2, '0');
  return `${minutes >= 0 ? '+' : '-'}${hours}${mins}`;
}

function formatDateInTimeZone(date, timeZone = DEFAULT_TIME_ZONE) {
  const targetDate = toDate(date);
  if (!targetDate) return '';

  const parts = getTimeZoneParts(targetDate, timeZone);
  if (!parts) return '';

  const monthIndex = Math.max(0, Math.min(11, Number(parts.monthNumber || 1) - 1));
  const monthName = MONTH_NAMES[monthIndex] || parts.monthNumber || '';
  const offsetMinutes = getTimeZoneOffsetMinutes(targetDate, timeZone);
  const offsetText = offsetMinutes === null ? '' : `GMT${formatTimeZoneOffset(offsetMinutes)}`;
  const zoneName = getTimeZoneDisplayName(targetDate, timeZone);

  return `${parts.weekday} ${monthName} ${parts.day} ${parts.year} ${parts.hour}:${parts.minute}:${parts.second} ${offsetText}${
    zoneName ? ` (${zoneName})` : ''
  }`.trim();
}

function timeZoneDateToUtc(localParts = {}, timeZone = DEFAULT_TIME_ZONE) {
  const year = Number(localParts.year || 0);
  const month = Number(localParts.month || 1) - 1;
  const day = Number(localParts.day || 1);
  const hour = Number(localParts.hour || 0);
  const minute = Number(localParts.minute || 0);
  const second = Number(localParts.second || 0);

  let utcMs = Date.UTC(year, month, day, hour, minute, second);
  for (let i = 0; i < 3; i += 1) {
    const offsetMinutes = getTimeZoneOffsetMinutes(new Date(utcMs), timeZone);
    const nextUtcMs = Date.UTC(year, month, day, hour, minute, second) - offsetMinutes * 60000;
    if (nextUtcMs === utcMs) break;
    utcMs = nextUtcMs;
  }
  return new Date(utcMs);
}

module.exports = {
  DEFAULT_TIME_ZONE,
  formatDateInTimeZone,
  getTimeZoneParts,
  getTimeZoneOffsetMinutes,
  timeZoneDateToUtc
};
