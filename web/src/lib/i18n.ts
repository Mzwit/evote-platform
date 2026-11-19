// All interface text lives here so new languages need no code changes.
// siSwati: DRAFT ONLY. Every string must be reviewed and approved by a qualified
// siSwati translator before any real use. Entries not yet translated fall back to English.
const en = {
  appName: 'EVote',
  prototype: 'Demonstration prototype with fictional data. Not certified for real elections.',
  vote: 'Vote', results: 'Results', checkReceipt: 'Check my receipt', officials: 'Election officials',
  language: 'Language',
  signIn: 'Sign in', nationalId: 'National ID number', password: 'Password', continue: 'Continue', back: 'Back',
  otpTitle: 'Enter the code we sent you', otpHelp: 'We sent a 6-digit code by SMS', otp: 'One-time code',
  yourElections: 'Your elections', noElections: 'You are not on the voter roll for any election.',
  notOpen: 'Voting is not open', open: 'Voting is open', start: 'Start voting',
  alreadyIssued: 'You have already received your ballot for this election. If your vote did not complete, contact the help desk.',
  constituency: 'Inkhundla (constituency)',
  stepOf: (a: number, b: number) => `Step ${a} of ${b}`,
  chooseUpTo: (n: number) => (n === 1 ? 'Choose one candidate' : `Choose up to ${n} candidates`),
  leaveBlank: 'I do not want to choose in this contest',
  review: 'Check your choices', noChoice: 'No choice', change: 'Change',
  confirmWarn: 'After you cast your vote you cannot change it.',
  cast: 'Cast my vote',
  securing: 'Locking your ballot on this device…', sending: 'Sending your sealed ballot…',
  waiting: 'Many people are voting right now. You are in the queue. Please keep this page open; we will continue automatically.',
  offline: 'Connection lost. Your ballot is safe on this page and will be sent when you are back online.',
  accepted: 'Your vote has been recorded', trackerLabel: 'Your tracking code',
  trackerHelp: 'Write this code down. You can use it to check that your ballot is on the public list. It does not show how you voted, and nobody can use it to find out.',
  copy: 'Copy code', copied: 'Copied',
  done: 'Finish and sign out',
  receiptTitle: 'Check a tracking code', election: 'Election', tracker: 'Tracking code', check: 'Check',
  onBoard: 'Found on the public bulletin board.', pending: 'Accepted and waiting to be added to the board.', notFound: 'No ballot with this tracking code.',
  preliminary: 'PRELIMINARY: not yet verified', verified: 'VERIFIED by the independent auditor, not yet officially declared', declared: 'OFFICIALLY DECLARED',
  turnout: 'Turnout', registered: 'Registered voters', participated: 'Voters who took part', notYet: 'Results are published only after the official count.',
  error: 'Something went wrong',
};

type Dict = { [K in keyof typeof en]: (typeof en)[K] };

const ss: Partial<Dict> = {
  vote: 'Vota', results: 'Imiphumela', signIn: 'Ngena', continue: 'Chubeka', back: 'Buyela emuva', language: 'Lulimi',
};

export const languages = { en: 'English', ss: 'siSwati (draft)' } as const;
let current: keyof typeof languages = 'en';
export const setLang = (l: keyof typeof languages) => { current = l; document.documentElement.lang = l; };
export const lang = () => current;
export const t = new Proxy({} as Dict, { get: (_o, k: string) => (current === 'ss' && (ss as any)[k]) || (en as any)[k] });
