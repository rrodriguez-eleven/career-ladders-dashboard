// Shared between generate-comparisons.js (Node) and index.html (browser).
// Keep these two copies IDENTICAL — if they drift, cache lookups will silently
// stop matching and everything falls back to the rule-based system (safe, but
// you lose the bespoke analysis until the copies are back in sync).

function fnv1aHash(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function jdTextOf(role) {
  if (role.jdUrls && role.jdUrls[0] && role.jdUrls[0].text) return role.jdUrls[0].text;
  return role.jdText || null;
}

function hasRealJD(role) {
  return !!jdTextOf(role);
}

// Everything that, if it changes, should invalidate the cached analysis for this role.
function roleContentString(role) {
  const jd = jdTextOf(role) || {};
  return [
    role.title, role.band, role.yrs,
    role.scope, role.complexity, role.autonomy, role.influence,
    jd.overview || '',
    (jd.essentialFunctions || []).join('|'),
    (jd.requirements || []).join('|'),
    (jd.preferred || []).join('|'),
  ].join('::');
}

function roleHash(role) {
  return fnv1aHash(roleContentString(role));
}

// Order-independent: same two roles hash the same regardless of which is passed first.
function pairHash(roleA, roleB) {
  const hashes = [roleHash(roleA), roleHash(roleB)].sort();
  return fnv1aHash(hashes.join('::'));
}

// Order-independent lookup key: dept + family + the two titles, sorted.
function pairKey(dept, family, titleA, titleB) {
  return [dept, family, [titleA, titleB].sort().join('~')].join('||');
}

if (typeof module !== 'undefined') {
  module.exports = { fnv1aHash, jdTextOf, hasRealJD, roleContentString, roleHash, pairHash, pairKey };
}
