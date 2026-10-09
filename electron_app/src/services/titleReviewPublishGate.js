function isTitleApprovedForPublish(fields = {}) {
  const status = String(fields['Title Review Status'] || '').trim().toLowerCase();
  const title = String(fields['Item Title'] || '').trim();
  return title.length <= 80 && (status === 'completed' || status === 'skipped - manual override');
}

module.exports = { isTitleApprovedForPublish };
