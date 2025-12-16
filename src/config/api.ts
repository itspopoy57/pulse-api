// ⚠️ IMPORTANT:
// If you're running the API on the same PC and testing on a REAL PHONE,
// replace 192.168.0.12 with your computer's LAN IP.
// If you're using an ANDROID EMULATOR on the same PC, you can use 10.0.2.2 instead.

export const API_BASE = "http://192.168.0.39:4000";

export async function apiFetch(
  path: string,
  options: RequestInit = {}
): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
}
