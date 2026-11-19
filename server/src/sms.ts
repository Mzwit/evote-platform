// SMS gateway adapter. Production: integrate the contracted Eswatini operator's SMS API
// behind this function (with delivery receipts and per-number rate limits).
import { config } from './config.ts';

export async function sendSms(phone: string | null, text: string): Promise<void> {
  if (!phone) return;
  if (!config.isProd || config.demoMode) return; // development / public demo: the code is shown on screen (devOtp) instead
  const url = process.env.SMS_GATEWAY_URL;
  if (!url) throw new Error('SMS_GATEWAY_URL not configured');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.SMS_GATEWAY_TOKEN ?? ''}` },
    body: JSON.stringify({ to: phone, text }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`SMS gateway error ${res.status}`);
}
