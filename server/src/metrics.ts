import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
export const metrics = {
  http: new client.Histogram({ name: 'evote_http_seconds', help: 'HTTP latency', labelNames: ['route', 'method', 'code'], buckets, registers: [registry] }),
  ballotsAccepted: new client.Counter({ name: 'evote_ballots_accepted_total', help: 'Ballots durably accepted', registers: [registry] }),
  ballotsReplayed: new client.Counter({ name: 'evote_ballots_idempotent_replay_total', help: 'Retries answered with the original receipt', registers: [registry] }),
  ballotsRejected: new client.Counter({ name: 'evote_ballots_rejected_total', help: 'Ballot submissions rejected', labelNames: ['reason'], registers: [registry] }),
  tokensIssued: new client.Counter({ name: 'evote_tokens_issued_total', help: 'Anonymous tokens issued', registers: [registry] }),
  logins: new client.Counter({ name: 'evote_logins_total', help: 'Login attempts', labelNames: ['result'], registers: [registry] }),
  inflight: new client.Gauge({ name: 'evote_admission_inflight', help: 'Requests being served', registers: [registry] }),
  queued: new client.Gauge({ name: 'evote_admission_queued', help: 'Requests waiting in the waiting room', registers: [registry] }),
  rejectedBusy: new client.Counter({ name: 'evote_admission_busy_total', help: 'Requests asked to retry later', registers: [registry] }),
  boardHeight: new client.Gauge({ name: 'evote_board_height', help: 'Entries sealed on the bulletin board', labelNames: ['election'], registers: [registry] }),
};
