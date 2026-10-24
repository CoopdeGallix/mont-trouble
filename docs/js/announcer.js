// What the announcer can talk about: who is about to arrive, who just did,
// milestones, leaders, records and group totals. Pure functions over the
// standings so they can be tested.
import { RACE, STATUS, computeStandings } from './race.js';

const DEFAULT_LAP_MS = 20 * 60 * 1000;
const UPCOMING_WINDOW_MS = 4 * 60 * 1000;
const OVERDUE_MS = 3 * 60 * 1000;
const RECENT_MS = 15 * 60 * 1000;
// Keep lists readable on a phone during bunches (e.g. end of loop 1).
const MAX_UPCOMING = 6;
const MAX_RECENT = 8;
const MAX_HIGHLIGHTS = 6;
const MAX_LEADERS = 5;
const DEPARTED_MS = 10 * 60 * 1000;
const MAX_DEPARTED = 6;

const KM_MILESTONES = [
  [21.1, 'Demi-marathon'],
  [42.2, 'Marathon'],
  [50, '50 km'],
  [60, '60 km'],
  [70, '70 km'],
  [80, '80 km'],
];
const DPLUS_MILESTONES = [1000, 2000, 3000, 4000, 5000];

export function sexLabel(v) {
  const s = String(v || '').toLowerCase();
  if (s === 'femme' || s === 'f') return 'Femmes';
  if (s === 'homme' || s === 'h' || s === 'm') return 'Hommes';
  return v || 'Autre';
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Milestones reached by finishing valid loop number n.
export function milestones(n) {
  const out = [];
  const before = (n - 1) * RACE.lapKm;
  const after = n * RACE.lapKm;
  for (const [km, label] of KM_MILESTONES) {
    if (before < km && after >= km) out.push(`${label} (${after.toFixed(1).replace('.', ',')} km)`);
  }
  for (const d of DPLUS_MILESTONES) {
    if ((n - 1) * RACE.lapDplus < d && n * RACE.lapDplus >= d) out.push(`${d.toLocaleString('fr-CA')} m de D+`);
  }
  if (n % 10 === 0) out.push(`${n}e boucle`);
  return out;
}

// Milestones the runner will reach by finishing the loop they are on, if it
// can still count (departed by 14:59:59).
export function nextMilestones(r) {
  if (!r.open || r.open.ts > RACE.lastStart) return [];
  return milestones(r.loops + 1);
}

export function announcerView(participants, events, now = Date.now()) {
  const { rows } = computeStandings(participants, events, now);
  const valid = (r) => r.laps.filter((l) => l.valid);

  // Field-wide medians as a fallback for runners with no history yet.
  const allLaps = rows.flatMap(valid);
  const fieldLap = median(allLaps.map((l) => l.ms)) ?? DEFAULT_LAP_MS;
  const fieldDown = median(allLaps.filter((l) => l.mid).map((l) => l.downMs));

  // --- about to arrive
  const upcoming = [];
  for (const r of rows) {
    if (r.status !== STATUS.ON_COURSE || !r.open) continue;
    const mine = valid(r);
    let expected;
    let basis;
    const downs = mine.filter((l) => l.mid).map((l) => l.downMs);
    if (r.open.mid) {
      // descent is 1.4 of the 2.4 km: ~55% of a loop before anyone has a split
      expected = r.open.mid + (median(downs) ?? fieldDown ?? fieldLap * 0.55);
      basis = 'sommet';
    } else if (r.open.virtual) {
      // Loop 1 without a summit time: the field median only reflects the
      // fastest finishers so far, so any guess would be wrong.
      continue;
    } else {
      expected = r.open.ts + (median(mine.map((l) => l.ms)) ?? fieldLap);
      basis = 'boucle';
    }
    const eta = expected - now;
    if (eta <= UPCOMING_WINDOW_MS && eta > -OVERDUE_MS) upcoming.push({ row: r, expected, eta, basis, next: nextMilestones(r) });
  }
  upcoming.sort((a, b) => a.expected - b.expected);

  // --- just left for another loop
  const departed = [];
  for (const r of rows) {
    if (r.status !== STATUS.ON_COURSE || !r.open || r.open.virtual) continue;
    if (now - r.open.ts > DEPARTED_MS || r.open.ts > now) continue;
    const prev = r.laps[r.laps.length - 1];
    departed.push({ row: r, ts: r.open.ts, loop: r.loops + 1, restMs: prev ? r.open.ts - prev.arr : null, next: nextMilestones(r) });
  }
  departed.sort((a, b) => b.ts - a.ts);

  // --- best loops of the day, for highlights
  const dayBest = allLaps.length ? Math.min(...allLaps.map((l) => l.ms)) : null;
  const sexBest = new Map();
  for (const r of rows) {
    for (const l of valid(r)) {
      const k = sexLabel(r.sex);
      if (!sexBest.has(k) || l.ms < sexBest.get(k)) sexBest.set(k, l.ms);
    }
  }

  // --- just arrived
  const recent = [];
  for (const r of rows) {
    for (const l of valid(r)) {
      if (now - l.arr > RECENT_MS || l.arr > now) continue;
      const tags = [];
      if (l.ms === dayBest) tags.push('Meilleure boucle de la journée');
      else if (r.sex && l.ms === sexBest.get(sexLabel(r.sex))) tags.push(`Meilleure boucle chez les ${sexLabel(r.sex).toLowerCase()}`);
      else if (r.loops >= 3 && l.ms === r.stats.best) tags.push('Record personnel');
      tags.push(...milestones(l.n));
      recent.push({ row: r, lap: l, tags });
    }
  }
  recent.sort((a, b) => b.lap.arr - a.lap.arr);

  // --- leaders overall and per sex
  const ranked = rows.filter((r) => r.rank != null && r.loops > 0);
  const withGap = (list) =>
    list.slice(0, MAX_LEADERS).map((r, i) => ({
      row: r,
      place: i + 1,
      gapLoops: i ? list[0].loops - r.loops : 0,
      gapMs: i && list[0].loops === r.loops ? r.lastArrival - list[0].lastArrival : null,
    }));
  const leaders = [{ label: 'Général', list: withGap(ranked) }];
  const sexes = [...new Set(ranked.map((r) => sexLabel(r.sex)).filter((s) => s !== 'Autre'))].sort();
  for (const s of sexes) leaders.push({ label: s, list: withGap(ranked.filter((r) => sexLabel(r.sex) === s)) });

  // --- records of the day
  const records = [];
  const best = (pick, label) => {
    let top = null;
    for (const r of rows) {
      for (const l of valid(r)) {
        const v = pick(l);
        if (v != null && (!top || v < top.ms)) top = { label, ms: v, row: r };
      }
    }
    if (top) records.push(top);
  };
  best((l) => l.ms, 'Boucle la plus rapide');
  best((l) => (l.mid ? l.upMs : null), 'Montée la plus rapide');
  best((l) => (l.mid ? l.downMs : null), 'Descente la plus rapide');

  // --- clock moments
  let lastCall = null;
  if (now >= RACE.lastStart - 30 * 60 * 1000 && now <= RACE.lastStart) {
    lastCall = { kind: 'can_start', list: rows.filter((r) => r.status === STATUS.RESTING) };
  } else if (now > RACE.lastStart && now <= RACE.end) {
    const onCourse = rows.filter((r) => r.status === STATUS.ON_COURSE && r.open);
    lastCall = {
      kind: 'final_loop',
      list: onCourse.map((r) => {
        const mine = valid(r).map((l) => l.ms);
        const expected = r.open.ts + (median(mine) ?? fieldLap);
        return { row: r, expected, atRisk: expected > RACE.end };
      }).sort((a, b) => a.expected - b.expected),
    };
  }

  // --- group totals
  const loops = rows.reduce((n, r) => n + r.loops, 0);
  const totals = {
    loops,
    km: Math.round(loops * RACE.lapKm),
    dplus: loops * RACE.lapDplus,
    onCourse: rows.filter((r) => r.status === STATUS.ON_COURSE).length,
    resting: rows.filter((r) => r.status === STATUS.RESTING).length,
    starters: rows.filter((r) => r.status !== STATUS.DNS).length,
  };

  // Tagged arrivals that fell off the short recent list, so milestones aren't buried.
  const shown = recent.slice(0, MAX_RECENT);
  const highlights = recent.slice(MAX_RECENT).filter((x) => x.tags.length);

  return {
    upcoming: upcoming.slice(0, MAX_UPCOMING),
    upcomingMore: Math.max(0, upcoming.length - MAX_UPCOMING),
    recent: shown,
    recentMore: Math.max(0, recent.length - MAX_RECENT),
    departed: departed.slice(0, MAX_DEPARTED),
    departedMore: Math.max(0, departed.length - MAX_DEPARTED),
    highlights: highlights.slice(0, MAX_HIGHLIGHTS),
    leaders,
    records,
    lastCall,
    totals,
  };
}
