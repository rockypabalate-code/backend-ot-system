function normalize(value) {
  return String(value || '').trim();
}

function nullable(value) {
  const normalized = normalize(value);
  return normalized || null;
}

function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function iso(value) {
  return value instanceof Date ? value.toISOString() : value || '';
}

function formatDateObjectLocal(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateOnly(value) {
  if (value instanceof Date) {
    return formatDateObjectLocal(value);
  }

  return value || '';
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isExecutor(value) {
  return value && typeof value.query === 'function';
}

function buildFullName({ firstName, middleName, lastName }) {
  return [firstName, middleName, lastName].map(normalize).filter(Boolean).join(' ');
}

module.exports = {
  buildFullName,
  dateOnly,
  iso,
  isExecutor,
  makeId,
  normalize,
  nullable,
  roundMoney,
  toNumber,
};
