// Shared race logic: turns raw timing events into loops, statuses and standings.
// Used by both the entry app (saisie.html) and the public page (index.html).

// Oct 24, 2026 is still daylight time in Québec (EDT, UTC-4).
export const RACE = {
  start: Date.parse('2026-10-24T09:00:00-04:00'),
  lastStart: Date.parse('2026-10-24T14:59:59-04:00'),
  end: Date.parse('2026-10-24T16:00:00-04:00'),
  minLapMs: 10 * 60 * 1000,
  lapKm: 2.4,
  lapDplus: 177,
  timeZone: 'America/Toronto',
};

export const STATUS = {
  ON_COURSE: 'on_course',
  RESTING: 'resting',
  DONE: 'done',
  DNF: 'dnf',
};

export const STATUS_LABEL = {
  on_course: 'En boucle',
  resting: 'Au repos',
  done: 'Terminé',
  dnf: 'Abandon',
};

// Drop voided events (VOID events reference the id they cancel, or the row
// was marked void in the Sheet) and duplicate ids.
export function activeEvents(events) {
  const voided = new Set();
  for (const e of events) if (e.type === 'VOID' && e.ref) voided.add(e.ref);
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (e.type === 'VOID' || e.void || voided.has(e.id)) continue;
    if (e.id && seen.has(e.id)) continue;
    if (e.id) seen.add(e.id);
    out.push(e);
  }
  return out;
}

export function groupByBib(events) {
  const byBib = new Map();
  for (const e of activeEvents(events)) {
    const bib = Number(e.bib);
    if (!byBib.has(bib)) byBib.set(bib, []);
    byBib.get(bib).push(e);
  }
  return byBib;
}

// Pair departures and arrivals for one runner. Everyone has a virtual
// departure at the mass start.
export function computeRunner(events, now = Date.now()) {
  const sorted = [...events].sort((a, b) => a.ts - b.ts);
  const laps = [];
  const flags = [];
  let open = { ts: RACE.start, virtual: true };
  let dnf = null;

  for (const e of sorted) {
    if (e.type === 'DNF') {
      if (open && !open.virtual && !dnf) {
        flags.push({ code: 'dnf_on_course', ts: e.ts, msg: 'Abandon pendant une boucle (départ sans arrivée)' });
      }
      dnf = dnf || e;
      continue;
    }
    if (e.type === 'D') {
      if (open && !open.virtual) {
        flags.push({ code: 'double_departure', ts: e.ts, msg: `Deux départs de suite (${fmtClock(open.ts)} et ${fmtClock(e.ts)}) : arrivée manquante ?` });
      }
      open = e;
    } else if (e.type === 'A') {
      if (!open) {
        flags.push({ code: 'arrival_without_departure', ts: e.ts, msg: `Arrivée à ${fmtClock(e.ts)} sans départ : départ manquant ?` });
        continue;
      }
      const lap = makeLap(open.ts, e.ts);
      if (lap.ms < RACE.minLapMs) {
        flags.push({ code: 'short_lap', ts: e.ts, msg: `Boucle de ${fmtDuration(lap.ms)} (< 10 min) à vérifier` });
      }
      laps.push(lap);
      open = null;
    }
  }

  const valid = laps.filter((l) => l.valid);
  valid.forEach((l, i) => (l.n = i + 1));

  let status;
  if (dnf) status = STATUS.DNF;
  else if (open) status = now > RACE.end ? STATUS.DONE : STATUS.ON_COURSE;
  else status = now > RACE.lastStart ? STATUS.DONE : STATUS.RESTING;

  for (const e of sorted) {
    if (dnf && e.type !== 'DNF' && e.ts > dnf.ts) {
      flags.push({ code: 'event_after_dnf', ts: e.ts, msg: `Saisie à ${fmtClock(e.ts)} après l'abandon` });
    }
  }

  const durations = valid.map((l) => l.ms);
  let restMs = 0;
  for (let i = 0; i < laps.length - 1; i++) restMs += Math.max(0, laps[i + 1].dep - laps[i].arr);
  if (open && !open.virtual && laps.length) restMs += Math.max(0, open.ts - laps[laps.length - 1].arr);

  return {
    laps,
    loops: valid.length,
    lastArrival: valid.length ? valid[valid.length - 1].arr : null,
    open: open ? { ts: open.ts, virtual: !!open.virtual } : null,
    status,
    dnf: dnf ? dnf.ts : null,
    flags,
    stats: {
      km: round1(valid.length * RACE.lapKm),
      dplus: valid.length * RACE.lapDplus,
      best: durations.length ? Math.min(...durations) : null,
      worst: durations.length ? Math.max(...durations) : null,
      mean: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      median: median(durations),
      restMs,
    },
  };
}

function makeLap(dep, arr) {
  const lap = { dep, arr, ms: arr - dep, valid: true, reason: null };
  if (dep > RACE.lastStart) {
    lap.valid = false;
    lap.reason = 'Départ après 14:59:59';
  } else if (arr > RACE.end) {
    lap.valid = false;
    lap.reason = 'Arrivée après 16:00';
  }
  return lap;
}

// Ranking: most valid loops, then earliest arrival of the last valid loop.
export function computeStandings(participants, events, now = Date.now()) {
  const byBib = groupByBib(events);
  const rows = participants.map((p) => ({
    ...p,
    bib: Number(p.bib),
    ...computeRunner(byBib.get(Number(p.bib)) || [], now),
  }));
  const known = new Set(rows.map((r) => r.bib));
  const unknownBibs = [...byBib.keys()].filter((b) => !known.has(b));

  rows.sort(
    (a, b) =>
      b.loops - a.loops ||
      (a.lastArrival ?? Infinity) - (b.lastArrival ?? Infinity) ||
      a.bib - b.bib
  );
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    r.rank = prev && prev.loops === r.loops && prev.lastArrival === r.lastArrival ? prev.rank : i + 1;
  });
  return { rows, unknownBibs };
}

// Warnings to show the timer before/after recording a new event for a bib.
export function checkNewEvent(runner, participant, type, ts) {
  const w = [];
  if (!participant) w.push('Dossard inconnu');
  if (ts < RACE.start) w.push('Avant le départ de 9:00 (test ?)');
  if (!runner) return w;
  if (runner.dnf && type !== 'DNF') w.push('Ce coureur a abandonné');
  if (type === 'D') {
    if (runner.open && !runner.open.virtual) w.push(`Déjà parti à ${fmtClock(runner.open.ts)} (arrivée manquante ?)`);
    if (runner.open && runner.open.virtual) w.push('Encore en 1re boucle (départ de 9:00)');
    if (ts > RACE.lastStart) w.push('Après 14:59:59 : cette boucle ne comptera pas');
  } else if (type === 'A') {
    if (!runner.open) w.push('Aucun départ ouvert (départ manquant ?)');
    else if (ts >= RACE.start && ts - runner.open.ts < RACE.minLapMs) w.push(`Boucle de ${fmtDuration(ts - runner.open.ts)} (< 10 min)`);
    if (ts > RACE.end) w.push('Après 16:00 : cette boucle ne comptera pas');
  } else if (type === 'DNF') {
    if (runner.dnf) w.push('Déjà marqué abandon');
  }
  return w;
}

// --- formatting -----------------------------------------------------------

const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: RACE.timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function fmtClock(ms) {
  if (ms == null) return '—';
  return clockFmt.format(new Date(ms));
}

export function fmtDuration(ms) {
  if (ms == null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// "HH:MM" or "HH:MM:SS" on race day -> epoch ms.
export function parseClock(str) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(str.trim());
  if (!m) return null;
  const [, h, mi, s = '00'] = m;
  return Date.parse(`2026-10-24T${h.padStart(2, '0')}:${mi}:${s}-04:00`);
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round1(x) {
  return Math.round(x * 10) / 10;
}
