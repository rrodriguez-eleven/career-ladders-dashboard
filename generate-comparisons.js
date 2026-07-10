#!/usr/bin/env node
/**
 * generate-comparisons.js
 *
 * Builds/updates comparisons.json — the pre-generated "bespoke analysis" cache
 * that index.html reads at load time and falls back gracefully from if a pair
 * isn't in it.
 *
 * WHAT IT DOES EACH RUN
 *   1. Reads job-data.json (an export of JOB_DATA from index.html).
 *   2. Walks every department/family and, for each role that has a `next`
 *      field, finds the role(s) it points to and treats that as a growth-path
 *      pair — this is more reliable than comparing band numbers, since two
 *      roles can share a nominal band but still be a real step up (e.g.
 *      Software Engineer -> Sr. Software Engineer are both "Band 1").
 *   3. Only pairs where BOTH roles have real JD text are eligible — without
 *      real JD text there's nothing bespoke to say that the rule-based
 *      fallback isn't already saying.
 *   4. For each eligible pair, computes a content hash of both roles. If that
 *      pair already exists in comparisons.json with the same hash, it's left
 *      untouched (no wasted API calls). If it's new or the hash changed
 *      (JD was edited), it gets (re)generated.
 *   5. Writes the merged result back to comparisons.json, plus a manifest.json
 *      summarizing what's covered, what's missing, and why.
 *
 * RUNNING IT
 *   Requires Node 18+ (for global fetch) and an Anthropic API key:
 *     ANTHROPIC_API_KEY=sk-ant-... node generate-comparisons.js
 *
 *   Without a key, it still runs — it reports exactly which pairs it WOULD
 *   generate or refresh, without spending any API calls or touching the
 *   cache. Use this to sanity-check before a real run, or to see what a
 *   JOB_DATA edit affected.
 *
 *   Flags:
 *     --dry-run        Force report-only mode even if a key is present
 *     --only=<title>   Limit to pairs involving a role whose title includes
 *                       this string (case-insensitive) — handy when you've
 *                       just added/edited one role and don't want a full run
 */

const fs = require('fs');
const path = require('path');
const { hasRealJD, pairHash, pairKey, jdTextOf } = require('./comparisons-shared.js');

const JOB_DATA_PATH = path.join(__dirname, 'job-data.json');
const CACHE_PATH = path.join(__dirname, 'comparisons.json');
const MANIFEST_PATH = path.join(__dirname, 'manifest.json');
const MODEL = 'claude-sonnet-4-6';

const args = process.argv.slice(2);
const FORCE_DRY_RUN = args.includes('--dry-run');
const ONLY_FILTER = (args.find(a => a.startsWith('--only=')) || '').split('=')[1];

function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

const jobData = loadJSON(JOB_DATA_PATH, null);
if (!jobData) {
  console.error(`Could not read ${JOB_DATA_PATH}. Export JOB_DATA from index.html into this file first.`);
  process.exit(1);
}

const existingCache = loadJSON(CACHE_PATH, { pairs: {} });

// ---- 1. Enumerate every role, keyed by dept+family+title, for `next` lookups ----
const rolesByFamily = {}; // "dept||family" -> [{title, dept, family, role}]
const roleIndex = {};     // "dept||family||title" -> {title, dept, family, role}

jobData.departments.forEach(dept => {
  // Note: departments can be partially built (see dept.status/statusNote) — we don't skip
  // them wholesale here, since the hasRealJD() filter below already correctly excludes any
  // individual role that doesn't have real JD text yet.
  (dept.families || []).forEach(fam => {
    const famKey = `${dept.name}||${fam.name}`;
    rolesByFamily[famKey] = rolesByFamily[famKey] || [];
    (fam.roles || []).forEach(role => {
      const entry = { title: role.title, dept: dept.name, family: fam.name, role };
      rolesByFamily[famKey].push(entry);
      roleIndex[`${dept.name}||${fam.name}||${role.title}`] = entry;
    });
  });
});

function findByTitleInFamily(dept, family, title) {
  const key = `${dept}||${family}||${title}`;
  if (roleIndex[key]) return roleIndex[key];
  // `next` sometimes points to a role that's technically in a different family
  // within the same department (e.g. an IC track pointing to a manager track).
  // Fall back to a department-wide search by title before giving up.
  for (const k of Object.keys(roleIndex)) {
    const [d, , t] = k.split('||');
    if (d === dept && t === title) return roleIndex[k];
  }
  return null;
}

// ---- 2. Build the candidate pair list: every same-family pair where both roles
// could plausibly be compared, not just adjacent `next` steps. A level-1 employee
// comparing themselves to a level-5/6 role in the same family is just as valid a
// comparison as the next step up, so we enumerate the full pairwise combination
// within each family. We still track which pairs are direct `next` steps (adjacent)
// vs skip-level/same-band, purely for reporting.
const candidates = [];
const seenKeys = new Set();
const adjacentKeys = new Set();

Object.values(roleIndex).forEach(entry => {
  const nextRaw = entry.role.next;
  if (!nextRaw) return;
  nextRaw.split(/\s+or\s+/i).forEach(rawTitle => {
    const nextTitle = rawTitle.replace(/\(.*?\)/g, '').trim();
    if (!nextTitle) return;
    const target = findByTitleInFamily(entry.dept, entry.family, nextTitle);
    if (!target) return;
    adjacentKeys.add(pairKey(entry.dept, entry.family, entry.title, target.title));
  });
});

Object.keys(rolesByFamily).forEach(famKey => {
  const roles = rolesByFamily[famKey];
  for (let i = 0; i < roles.length; i++) {
    for (let j = i + 1; j < roles.length; j++) {
      const a = roles[i], b = roles[j];
      const key = pairKey(a.dept, a.family, a.title, b.title);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      // Order by band (lower on the left) where bands are comparable, purely so
      // headlines read naturally ("Moving from X to Y..."); doesn't affect same-band pairs.
      const bandA = parseFloat(a.role.band), bandB = parseFloat(b.role.band);
      const [junior, senior] = (!isNaN(bandA) && !isNaN(bandB) && bandA > bandB) ? [b, a] : [a, b];
      candidates.push({
        key,
        dept: a.dept,
        family: a.family,
        junior,
        senior,
        isAdjacent: adjacentKeys.has(key),
      });
    }
  }
});

// ---- 3. Filter to pairs where both sides have real JD text, and apply --only ----
let eligible = candidates.filter(c => hasRealJD(c.junior.role) && hasRealJD(c.senior.role));
const skippedNoJD = candidates.length - eligible.length;

if (ONLY_FILTER) {
  const f = ONLY_FILTER.toLowerCase();
  eligible = eligible.filter(c =>
    c.junior.title.toLowerCase().includes(f) || c.senior.title.toLowerCase().includes(f)
  );
}

// ---- 4. Diff against existing cache ----
const toGenerate = [];
const unchanged = [];
eligible.forEach(c => {
  const hash = pairHash(c.junior.role, c.senior.role);
  const cached = existingCache.pairs[c.key];
  if (cached && cached.contentHash === hash) {
    unchanged.push(c.key);
  } else {
    toGenerate.push({ ...c, hash });
  }
});

console.log(`Candidate same-family pairs found (all combinations, not just adjacent steps): ${candidates.length}`);
console.log(`Skipped (missing JD text on one or both sides): ${skippedNoJD}`);
console.log(`Eligible pairs (both sides have JD text)${ONLY_FILTER ? ` matching "${ONLY_FILTER}"` : ''}: ${eligible.length}`);
console.log(`  Already cached and unchanged: ${unchanged.length}`);
console.log(`  New or changed, need (re)generation: ${toGenerate.length}`);
if (toGenerate.length) {
  toGenerate.forEach(c => console.log(`    - ${c.junior.title} -> ${c.senior.title}  [${c.dept} / ${c.family}]${c.isAdjacent ? '' : '  (skip-level or same-band)'}`));
}

const hasKey = !!process.env.ANTHROPIC_API_KEY;
const dryRun = FORCE_DRY_RUN || !hasKey || toGenerate.length === 0;

if (!hasKey && toGenerate.length) {
  console.log(`\nNo ANTHROPIC_API_KEY set — running in report-only mode. Nothing was generated or written.`);
  console.log(`Set ANTHROPIC_API_KEY and re-run to actually generate the ${toGenerate.length} pair(s) above.`);
}
if (dryRun) {
  writeManifest();
  process.exit(0);
}

// ---- 5. Generate via the Anthropic API ----
const PROMPT_INSTRUCTIONS = `
You are writing bespoke, role-aware analysis for an internal career-ladder comparison tool at a company called Eleven Software.
You will be given two roles in the same job family, "junior" (lower or equal band) and "senior" (higher or equal band), including their scope/complexity/autonomy/influence text and full job description (overview, essential functions, requirements, preferred). These may be adjacent steps, a multi-band skip-level jump, or the same band (a lateral/peer comparison) — check the band values to tell which.

Write analysis that is SPECIFIC to what these two JDs actually say — do not use generic corporate-ladder boilerplate, and do not assume the roles are technical/engineering unless the JD text says so. If these are Sales, Finance, Customer Support, People, or any other non-engineering roles, your language must reflect that domain, not default to software-engineering framing (no "code," "architecture," "sprints," etc. unless the JD text actually uses that language).

Return ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:
{
  "headline": "one sentence describing the nature of this comparison. If bands differ, something like: 'Moving from X to Y is a 1-band jump and roughly 3+ more years of experience.' If it's a skip-level (2+ bands), say so explicitly (e.g. 'is a 3-band skip-level jump'). If the bands are equal, frame it as a lateral/peer comparison instead (e.g. 'X and Y sit at the same band but focus on different halves of the function.')",
  "section1Title": "'Growth Areas' if senior's band is higher than junior's (any gap size), or 'Key Differences' if they're the same band (a peer/lateral comparison)",
  "growthAreasSub": "one sentence describing what this section covers for this SPECIFIC pair",
  "growthAreas": [
    { "theme": "short theme label", "left": ["bullet from junior JD, verbatim or lightly cleaned"], "right": ["bullet from senior JD"], "synthesis": "2-3 sentences: what this specific difference means, referencing the actual content. For Growth Areas, focus on how someone would realistically build it. For Key Differences (same band), focus on what actually distinguishes the two, not how to progress." }
  ],
  "dayToDaySub": "one sentence describing what the day-to-day section covers for this pair",
  "dayToDay": [
    { "theme": "short theme label", "left": [...], "right": [...], "synthesis": "2-3 sentences focused on how the actual daily rhythm differs, grounded in the JD text, not a repeat of the growth-areas/key-differences synthesis" }
  ],
  "mainTakeaways": ["2-3 short strings using the ACTUAL role titles (not placeholders), each a genuinely specific observation about THIS pair, may include <strong> tags around a key phrase"],
  "worthExploring": [ { "theme": "...", "rec": "one concrete, actionable next step someone could actually take, specific to this domain. For Growth Areas pairs, frame as building toward the senior role. For Key Differences (same band) pairs, frame as a way to explore/validate the difference (e.g. a question to ask someone in each seat), not as advice to progress." } ]
}

If this is a large skip-level jump (2+ bands, especially if it spans what would normally be multiple promotion steps), call that out explicitly in the headline and Main Takeaways — don't just treat it like a normal adjacent step.
Only include a theme row in growthAreas/dayToDay if you have at least 2-3 real bullets total across both sides for it — otherwise fold those items into a final theme called "Other" with a synthesis describing them as additional skills that don't cluster into one theme.
Keep each bullet under ~20 words, cleaned up from the raw JD phrasing but not fabricated.
`.trim();

async function generatePair(c) {
  const jdJ = jdTextOf(c.junior.role), jdS = jdTextOf(c.senior.role);
  const userContent = JSON.stringify({
    department: c.dept,
    family: c.family,
    junior: {
      title: c.junior.title, band: c.junior.role.band, yrs: c.junior.role.yrs,
      scope: c.junior.role.scope, complexity: c.junior.role.complexity,
      autonomy: c.junior.role.autonomy, influence: c.junior.role.influence,
      jd: jdJ,
    },
    senior: {
      title: c.senior.title, band: c.senior.role.band, yrs: c.senior.role.yrs,
      scope: c.senior.role.scope, complexity: c.senior.role.complexity,
      autonomy: c.senior.role.autonomy, influence: c.senior.role.influence,
      jd: jdS,
    },
  });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 3000,
      system: PROMPT_INSTRUCTIONS,
      messages: [{ role: 'user', content: userContent }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status} for ${c.key}: ${text.slice(0, 500)}`);
  }
  const data = await res.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error(`No text content returned for ${c.key}`);
  const cleaned = textBlock.text.trim().replace(/^```json\s*/i, '').replace(/```$/, '');
  return JSON.parse(cleaned);
}

(async () => {
  const merged = { pairs: { ...existingCache.pairs } };
  let failures = 0;
  for (const c of toGenerate) {
    process.stdout.write(`Generating ${c.junior.title} -> ${c.senior.title}... `);
    try {
      const analysis = await generatePair(c);
      merged.pairs[c.key] = {
        contentHash: c.hash,
        dept: c.dept,
        family: c.family,
        juniorTitle: c.junior.title,
        seniorTitle: c.senior.title,
        generatedAt: new Date().toISOString(),
        analysis,
      };
      console.log('done');
    } catch (err) {
      console.log('FAILED');
      console.error(`  ${err.message}`);
      failures++;
    }
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(merged, null, 2));
  console.log(`\nWrote ${CACHE_PATH} (${Object.keys(merged.pairs).length} total pairs cached, ${failures} failure(s) this run).`);
  writeManifest(merged);
})();

function writeManifest(mergedOverride) {
  const cache = mergedOverride || existingCache;
  const manifest = {
    generatedAt: new Date().toISOString(),
    totalCandidatePairs: candidates.length,
    skippedMissingJD: skippedNoJD,
    eligiblePairs: eligible.length,
    cachedPairs: Object.keys(cache.pairs || {}).length,
    pendingGeneration: toGenerate.map(c => ({ key: c.key, junior: c.junior.title, senior: c.senior.title, dept: c.dept, family: c.family })),
    coveredPairs: Object.keys(cache.pairs || {}),
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}
