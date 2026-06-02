const DEFAULT_TIME_ZONE = 'EST';
const FIXED_OFFSET_MINUTES = -5 * 60;
const FIXED_TIME_ZONE_LABEL = 'Eastern Standard Time';

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

  const shifted = new Date(targetDate.getTime() + FIXED_OFFSET_MINUTES * 60 * 1000);
  return {
    weekday: WEEKDAY_NAMES[shifted.getUTCDay()] || '',
    monthNumber: String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    day: String(shifted.getUTCDate()).padStart(2, '0'),
    year: String(shifted.getUTCFullYear()),
    hour: String(shifted.getUTCHours()).padStart(2, '0'),
    minute: String(shifted.getUTCMinutes()).padStart(2, '0'),
    second: String(shifted.getUTCSeconds()).padStart(2, '0')
  };
}

function getTimeZoneDisplayName(date, timeZone = DEFAULT_TIME_ZONE) {
  return FIXED_TIME_ZONE_LABEL;
}

function getTimeZoneOffsetMinutes(date, timeZone = DEFAULT_TIME_ZONE) {
  return FIXED_OFFSET_MINUTES;
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
  return new Date(Date.UTC(year, month, day, hour, minute, second) - FIXED_OFFSET_MINUTES * 60000);
}

module.exports = {
  DEFAULT_TIME_ZONE,
  formatDateInTimeZone,
  getTimeZoneParts,
  getTimeZoneOffsetMinutes,
  timeZoneDateToUtc
};
