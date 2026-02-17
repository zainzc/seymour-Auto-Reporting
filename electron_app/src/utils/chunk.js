function chunkArray(items, size) {
  if (!Array.isArray(items)) return [];
  if (!size || size <= 0) return [items.slice()];

  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

module.exports = {
  chunkArray
};

