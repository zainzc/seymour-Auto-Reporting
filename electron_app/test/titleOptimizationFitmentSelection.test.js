const test = require('node:test');
const assert = require('node:assert/strict');
const { parseApplicationClauses, selectTitleFitmentCandidates } = require('../src/services/titleOptimizationFitmentSelectionService');

test('HTML fitment rows retain semicolon qualifiers and expand short year ranges', () => {
  const rows = parseApplicationClauses('CENTURY 97-98 Power; heated, R.<br>CENTURY 99-02 Power; heated, opt DE5, R.');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => [row.startYear, row.endYear]), [[1997, 1998], [1999, 2002]]);
  assert.match(rows[0].evidence, /Power; heated, R/);
});

test('structured full-year semicolon fitment rows still parse separately', () => {
  const rows = parseApplicationClauses('2010-2012 Subaru Outback; 2013 Subaru Outback');
  assert.deepEqual(rows.map(row => [row.startYear, row.endYear]), [[2010, 2012], [2013, 2013]]);
});

test('a build date is not mistaken for a short model year', () => {
  assert.deepEqual(parseApplicationClauses('Nissan Rogue build date 11/06 VIN J'), []);
  assert.deepEqual(parseApplicationClauses('build date 11/06/2012'), []);
});

test('semicolon restrictions stay attached to their vehicle application', () => {
  const rows = parseApplicationClauses('2010-2011 Example Sedan Mirror; without heat; from 10/01/2010; 2012 Example Sedan Mirror; with heat');
  assert.equal(rows.length, 2);
  assert.match(rows[0].evidence, /without heat; from 10\/01\/2010/);
  assert.match(rows[1].evidence, /with heat/);
});

test('two-digit fitment years follow the client 00-30 and 31-99 century boundary', () => {
  const rows = parseApplicationClauses('1931-1932 Example Roadster; Example Coupe 31-33');
  assert.deepEqual(rows.map(row => row.startYear), [1931, 1931]);
});

test('an unmatched model token keeps all source rows available for AI normalization', () => {
  const result = selectTitleFitmentCandidates({ normalized: {
    fields: { existingTitle: { value: '2004 Example Modelxx Mirror Fits 04-06 MODELXX 123' } },
    titleAuthority: { partFitment: { value: '2004-2006 Example Model X Mirror' } }
  } });
  assert.equal(result.resolution, 'AI_SELECTION_REQUIRED');
  assert.equal(result.eligibleCandidates.length, 1);
});
