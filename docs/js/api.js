// Talks to the Apps Script web app (or the local mock server in dev).

// Paste the Apps Script web app URL here after deploying (ends with /exec).
const DEFAULT_ENDPOINT = 'https://script.google.com/macros/s/AKfycbz712XnQo5cwhmjTICGwGrnrRmEKqZYDtNH3ewQYMyVkSIVx4fnKM-PPz0KSLc8oitC/exec';

// `?api=http://localhost:8765/api` overrides the endpoint (local testing).
export function endpoint() {
  const override = new URLSearchParams(location.search).get('api');
  return override || DEFAULT_ENDPOINT;
}

export async function fetchData() {
  const res = await fetch(`${endpoint()}?action=data&t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data; // { participants, events, serverTime }
}

// text/plain avoids a CORS preflight, which Apps Script cannot answer.
export async function postEvents(pin, events) {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'events', pin, events }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data; // { ok, accepted: [ids], duplicates: [ids] }
}

// Late registration. Needs the network (not queued like timing events).
export async function postParticipant(pin, participant) {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'participant', pin, participant }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}
