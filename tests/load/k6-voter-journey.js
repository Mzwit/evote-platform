// k6 distributed load test (Phase 13) for the 10k -> 500k ramp. NOT run in this
// workspace (k6 is not installed here). Run from several load-generator machines
// with k6's distributed mode or k6-operator, against a STAGING copy of the platform.
//
// Device-side crypto (RFC 9474 blinding, HPKE encryption) cannot run in k6, so:
//   1. node tests/load/prepare-k6.ts --voters N   pre-computes, per voter, the blinded
//      token request and the encrypted ballot (and the unblinding data) -> k6-data.json
//   2. Scenario "identity": login -> OTP -> ballot -> token (the CPU-heavy tier).
//   3. Scenario "cast_storm": casts pre-issued ballots as fast as allowed (the write tier).
// Every write is idempotent, so k6 retries are safe.
//
//   k6 run -e BASE=https://staging.vote.example.sz -e STAGE=500000 tests/load/k6-voter-journey.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import { Trend, Counter } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://localhost:8080';
const PEAK = Number(__ENV.STAGE || 10000);   // 10000 | 50000 | 100000 | 250000 | 500000
const voters = new SharedArray('voters', () => JSON.parse(open('./k6-data.json')).voters);
const casts = new SharedArray('casts', () => JSON.parse(open('./k6-data.json')).casts);
const election = JSON.parse(open('./k6-data.json')).electionId;

const loginT = new Trend('step_login', true), tokenT = new Trend('step_token', true), castT = new Trend('step_cast', true);
const waitingRoom = new Counter('waiting_room_503');

export const options = {
  scenarios: {
    identity: { executor: 'ramping-vus', exec: 'identity', startVUs: 0,
      stages: [{ duration: '5m', target: PEAK * 0.2 }, { duration: '10m', target: PEAK }, { duration: '20m', target: PEAK }, { duration: '2m', target: PEAK * 2 }, { duration: '5m', target: 0 }] },
    cast_storm: { executor: 'ramping-arrival-rate', exec: 'castStorm', startRate: 10, timeUnit: '1s', preAllocatedVUs: 2000, maxVUs: 20000,
      stages: [{ duration: '5m', target: 200 }, { duration: '10m', target: 1000 }, { duration: '2m', target: 2000 }, { duration: '3m', target: 0 }] },
  },
  thresholds: {
    'http_req_failed{scenario:cast_storm}': ['rate<0.001'],
    step_cast: ['p(95)<500', 'p(99)<1000'],
    step_token: ['p(95)<1000'],
  },
};

const json = { headers: { 'content-type': 'application/json' } };
function post(path, body, session) {
  for (let i = 0; i < 20; i++) {
    const r = http.post(BASE + path, JSON.stringify(body), { headers: { 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session}` } : {}) } });
    if (r.status !== 503) return r;
    waitingRoom.add(1); sleep(1 + Math.random() * 4);
  }
  return null;
}

export function identity() {
  const v = voters[(__VU * 7919 + __ITER) % voters.length];
  let r = post('/api/voter/login', { nationalId: v.nationalId, password: v.password }); if (!r) return;
  loginT.add(r.timings.duration);
  if (!check(r, { 'login 200': (x) => x.status === 200 })) return;
  const l = r.json();
  r = post('/api/voter/otp', { challengeId: l.challengeId, code: l.devOtp }, l.session); if (!r || r.status !== 200) return;
  const s = r.json().session;
  sleep(20 + Math.random() * 40);  // a person reads the ballot
  http.get(`${BASE}/api/voter/elections/${election}/ballot`, { headers: { authorization: `Bearer ${s}` } });
  r = post(`/api/voter/elections/${election}/token`, { blinded: v.blinded }, s);
  if (r) { tokenT.add(r.timings.duration); check(r, { 'token 200 or 409 (already issued)': (x) => x.status === 200 || x.status === 409 }); }
}

export function castStorm() {
  const c = casts[(__VU * 104729 + __ITER) % casts.length];
  const r = post('/api/cast', c);
  if (r) { castT.add(r.timings.duration); check(r, { 'cast accepted or idempotent replay': (x) => x.status === 200 }); }
}
