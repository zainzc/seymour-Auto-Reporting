function isTitleApprovedForPublish(fields = {}) {
  const status = String(fields['Title Review Status'] || '').trim().toLowerCase();
  return status === 'completed' || status === 'skipped - manual override';
}

module.exports = { isTitleApprovedForPublish };
