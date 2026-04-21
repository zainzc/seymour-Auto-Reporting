function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeIpn(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeKey(value) {
  return normalizeText(value).toLowerCase();
}

function asIdentitySet(values = []) {
  const out = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = normalizeText(value);
    if (!text) continue;
    out.add(text);
  }
  return out;
}

function getFieldValueByName(fields = {}, name = '') {
  if (!fields || typeof fields !== 'object') return '';
  if (Object.prototype.hasOwnProperty.call(fields, name)) return fields[name];
  const target = normalizeKey(name);
  if (!target) return '';
  const key = Object.keys(fields).find(item => normalizeKey(item) === target);
  if (!key) return '';
  return fields[key];
}

function firstNonEmptyField(fields = {}, names = []) {
  for (const name of Array.isArray(names) ? names : []) {
    const value = normalizeText(getFieldValueByName(fields, name));
    if (value) return value;
  }
  return '';
}

function buildListingIdentity(fields = {}, hints = {}) {
  const itemId = firstNonEmptyField(fields, hints.itemIdFields || [
    'Item ID',
    'ItemID',
    'eBay Item ID',
    'Ebay Item ID',
    'Listing ID',
    'ListingID'
  ]);
  if (itemId) return `ITEM:${itemId}`;

  const ipn = normalizeIpn(
    firstNonEmptyField(fields, hints.ipnFields || [
      'c: partshunter203 ebay MOTORS interchange part number',
      'C: partshunter203 ebay MOTORS interchange part number',
      'IPN',
      'IP',
      'InventoryNumber',
      'Inventory Number'
    ])
  );
  if (ipn) return `IPN:${ipn}`;

  const recordKey = firstNonEmptyField(fields, hints.recordKeyFields || [
    'eBay Item ID',
    'Ebay Item ID',
    'Record Key'
  ]);
  if (recordKey) return `RK:${recordKey}`;
  return '';
}

function isPublishedIdentity(fields = {}, publishedIdentitySet = new Set(), hints = {}) {
  if (!(publishedIdentitySet instanceof Set) || publishedIdentitySet.size === 0) return false;
  const identity = buildListingIdentity(fields, hints);
  if (!identity) return false;
  return publishedIdentitySet.has(identity);
}

module.exports = {
  normalizeText,
  normalizeIpn,
  asIdentitySet,
  buildListingIdentity,
  isPublishedIdentity
};
