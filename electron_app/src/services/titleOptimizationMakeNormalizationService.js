const MAKE_ACRONYMS = new Set(['BMW', 'GMC', 'MG', 'AMG', 'RAM']);

function normalizeVehicleMake(value) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  return text.replace(/[A-Za-z]+/g, word => MAKE_ACRONYMS.has(word.toUpperCase())
    ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1).toLowerCase());
}

function corroboratesAuthoritativeMake(authoritative, other) {
  const full = normalizeVehicleMake(authoritative).toLowerCase();
  const shorter = normalizeVehicleMake(other).toLowerCase();
  return Boolean(shorter && (full === shorter || full.startsWith(`${shorter} `)));
}

module.exports = { normalizeVehicleMake, corroboratesAuthoritativeMake };
