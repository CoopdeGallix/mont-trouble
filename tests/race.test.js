import { RACE, STATUS, computeRunner, computeStandings, checkNewEvent, activeEvents, parseClock, fmtDuration, fmtClock } from '../docs/js/race.js';

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, err: String(err.message || err) });
  }
}
function eq(actual, expected, label = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label} expected ${b}, got ${a}`);
}

const t = (hms) => parseClock(hms);
let n = 0;
const ev = (bib, type, hms, extra = {}) => ({ id: `e${++n}`, bib, type, ts: t(hms), ...extra });
const NOON = t('12:00');

test('parseClock is race-day local time', () => {
  eq(t('09:00'), RACE.start);
  eq(t('14:59:59'), RACE.lastStart);
  eq(t('9:00:00'), RACE.start);
  eq(parseClock('nope'), null);
});

test('first loop starts at mass start', () => {
  const r = computeRunner([ev(1, 'A', '09:20:00')], NOON);
  eq(r.loops, 1);
  eq(r.laps[0].ms, 20 * 60000);
  eq(r.status, STATUS.RESTING);
});

test('rest between loops is not counted in loop time', () => {
  const r = computeRunner([ev(1, 'A', '09:20'), ev(1, 'D', '09:30'), ev(1, 'A', '09:52')], NOON);
  eq(r.loops, 2);
  eq(r.laps[1].ms, 22 * 60000);
  eq(r.stats.restMs, 10 * 60000);
  eq(r.stats.best, 20 * 60000);
  eq(r.stats.km, 4.8);
  eq(r.stats.dplus, 354);
});

test('runner is on course after a departure', () => {
  const r = computeRunner([ev(1, 'A', '09:20'), ev(1, 'D', '09:30')], NOON);
  eq(r.status, STATUS.ON_COURSE);
  eq(r.open.ts, t('09:30'));
});

test('departure at 14:59:59 counts, at 15:00:00 does not', () => {
  const ok = computeRunner([ev(1, 'A', '14:50'), ev(1, 'D', '14:59:59'), ev(1, 'A', '15:20')], t('16:30'));
  eq(ok.loops, 2);
  const late = computeRunner([ev(1, 'A', '14:50'), ev(1, 'D', '15:00:00'), ev(1, 'A', '15:20')], t('16:30'));
  eq(late.loops, 1);
  eq(late.laps[1].reason, 'Départ après 14:59:59');
});

test('arrival after 16:00 does not count', () => {
  const r = computeRunner([ev(1, 'A', '14:40'), ev(1, 'D', '14:55'), ev(1, 'A', '16:00:01')], t('16:30'));
  eq(r.loops, 1);
  eq(r.lastArrival, t('14:40'));
});

test('arrival at exactly 16:00:00 counts', () => {
  const r = computeRunner([ev(1, 'A', '14:40'), ev(1, 'D', '14:55'), ev(1, 'A', '16:00:00')], t('16:30'));
  eq(r.loops, 2);
});

test('missing arrival: two departures are flagged, first loop dropped', () => {
  const r = computeRunner([ev(1, 'A', '09:20'), ev(1, 'D', '09:25'), ev(1, 'D', '10:10'), ev(1, 'A', '10:30')], NOON);
  eq(r.loops, 2);
  eq(r.flags.map((f) => f.code), ['double_departure']);
});

test('missing departure: arrival without departure is flagged', () => {
  const r = computeRunner([ev(1, 'A', '09:20'), ev(1, 'A', '09:50')], NOON);
  eq(r.loops, 1);
  eq(r.flags.map((f) => f.code), ['arrival_without_departure']);
});

test('short loop is flagged', () => {
  const r = computeRunner([ev(1, 'A', '09:20'), ev(1, 'D', '09:21'), ev(1, 'A', '09:25')], NOON);
  eq(r.flags.map((f) => f.code), ['short_lap']);
});

test('events are sorted by time regardless of entry order', () => {
  const r = computeRunner([ev(1, 'A', '09:52'), ev(1, 'D', '09:30'), ev(1, 'A', '09:20')], NOON);
  eq(r.loops, 2);
  eq(r.flags, []);
});

test('VOID cancels an event, and void flag from the Sheet too', () => {
  const a = ev(1, 'A', '09:20');
  const wrong = ev(1, 'A', '09:21');
  const list = activeEvents([a, wrong, { id: 'v1', type: 'VOID', ref: wrong.id, ts: 0 }, ev(1, 'D', '09:30', { void: true })]);
  eq(list.map((e) => e.id), [a.id]);
});

test('duplicate ids are counted once', () => {
  const a = ev(1, 'A', '09:20');
  eq(activeEvents([a, { ...a }]).length, 1);
});

test('DNF: status, loops kept, events after flagged', () => {
  const r = computeRunner([ev(1, 'A', '09:20'), ev(1, 'DNF', '09:40'), ev(1, 'D', '09:45')], NOON);
  eq(r.status, STATUS.DNF);
  eq(r.loops, 1);
  eq(r.flags.map((f) => f.code), ['event_after_dnf']);
});

test('statuses after the cutoffs', () => {
  eq(computeRunner([ev(1, 'A', '14:50')], t('15:10')).status, STATUS.DONE);
  eq(computeRunner([ev(1, 'A', '14:50'), ev(1, 'D', '14:58')], t('15:10')).status, STATUS.ON_COURSE);
  eq(computeRunner([ev(1, 'A', '14:50'), ev(1, 'D', '14:58')], t('16:10')).status, STATUS.DONE);
});

test('standings: loops desc, then earliest last arrival, ties share rank', () => {
  const people = [1, 2, 3, 4].map((bib) => ({ bib, name: `R${bib}` }));
  const events = [
    ev(1, 'A', '09:20'), ev(1, 'D', '09:25'), ev(1, 'A', '09:50'),
    ev(2, 'A', '09:18'), ev(2, 'D', '09:20'), ev(2, 'A', '09:45'),
    ev(3, 'A', '09:30'),
    ev(99, 'A', '09:30'),
  ];
  const { rows, unknownBibs } = computeStandings(people, events, NOON);
  eq(rows.map((r) => [r.bib, r.rank]), [[2, 1], [1, 2], [3, 3], [4, 4]]);
  eq(unknownBibs, [99]);
});

test('checkNewEvent warnings', () => {
  const p = { bib: 1 };
  const fresh = computeRunner([], NOON);
  eq(checkNewEvent(fresh, p, 'A', t('09:20')), []);
  eq(checkNewEvent(fresh, p, 'D', t('09:20')), ['Encore en 1re boucle (départ de 9:00)']);
  const resting = computeRunner([ev(1, 'A', '09:20')], NOON);
  eq(checkNewEvent(resting, p, 'A', t('09:40')), ['Aucun départ ouvert (départ manquant ?)']);
  eq(checkNewEvent(resting, p, 'D', t('15:01')), ['Après 14:59:59 : cette boucle ne comptera pas']);
  eq(checkNewEvent(null, null, 'A', t('09:40')), ['Dossard inconnu']);
  eq(checkNewEvent(fresh, p, 'A', t('08:30')), ['Avant le départ de 9:00 (test ?)']);
});

test('summit splits a loop into climb and descent', () => {
  const r = computeRunner([ev(1, 'M', '09:08'), ev(1, 'A', '09:20'), ev(1, 'D', '09:25'), ev(1, 'A', '09:47')], NOON);
  eq(r.loops, 2);
  eq([r.laps[0].upMs, r.laps[0].downMs], [8 * 60000, 12 * 60000]);
  eq(r.laps[1].mid, undefined, 'loop without summit time has no split');
  eq([r.stats.bestUp, r.stats.bestDown], [8 * 60000, 12 * 60000]);
  eq(r.flags, []);
});

test('summit time only counts for the loop it belongs to', () => {
  const r = computeRunner([ev(1, 'A', '09:20'), ev(1, 'D', '09:25'), ev(1, 'M', '09:33')], NOON);
  eq(r.open.mid, t('09:33'));
  const next = computeRunner([ev(1, 'M', '09:08'), ev(1, 'A', '09:20'), ev(1, 'D', '09:25')], NOON);
  eq(next.open.mid, null);
});

test('summit flags: no departure, two in one loop', () => {
  const r = computeRunner([ev(1, 'A', '09:20'), ev(1, 'M', '09:30')], NOON);
  eq(r.flags.map((f) => f.code), ['mid_without_departure']);
  const d = computeRunner([ev(1, 'M', '09:08'), ev(1, 'M', '09:09')], NOON);
  eq(d.flags.map((f) => f.code), ['double_mid']);
  eq(d.open.mid, t('09:08'), 'first summit time kept');
});

test('phase shown only while the summit station is active', () => {
  const people = [{ bib: 1 }, { bib: 2 }];
  const events = [ev(1, 'M', '10:05'), ev(2, 'A', '10:00'), ev(2, 'D', '10:02')];
  const active = computeStandings(people, events, t('10:10'));
  eq(active.summitActive, true);
  eq(active.rows.map((r) => [r.bib, r.phase]), [[2, 'up'], [1, 'down']]);
  const stale = computeStandings(people, events, t('10:30'));
  eq(stale.summitActive, false);
  eq(stale.rows.map((r) => r.phase), [null, null]);
});

test('checkNewEvent for summit', () => {
  const p = { bib: 1 };
  eq(checkNewEvent(computeRunner([], NOON), p, 'M', t('09:08')), []);
  eq(checkNewEvent(computeRunner([ev(1, 'A', '09:20')], NOON), p, 'M', t('09:30')), ['Pas en boucle (départ manquant ?)']);
  eq(checkNewEvent(computeRunner([ev(1, 'M', '09:08')], NOON), p, 'M', t('09:09')), ['Déjà passé au sommet à 09:08:00']);
});

test('fmtDuration', () => {
  eq(fmtDuration(20 * 60000 + 5000), '20:05');
  eq(fmtDuration(3600000 + 61000), '1:01:01');
  eq(fmtDuration(-5000), '0:00');
});

test('fmtClock is HH:MM:SS in race time zone', () => {
  eq(fmtClock(t('09:05:07')), '09:05:07');
  eq(fmtClock(t('15:00')), '15:00:00');
});

document.getElementById('out').textContent = JSON.stringify(results);
