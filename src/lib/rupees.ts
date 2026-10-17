/**
 * Rupee text from a form field to integer paise, with no floating point anywhere (brief: money is integer
 * paise only). Accepts "1499", "1,499", "1499.5" and "1499.50"; rejects everything else.
 */
export function parseRupees(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const text = input.trim().replace(/,/g, '');
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!m) return null;
  const rupees = Number(m[1]);
  const paise = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  return rupees * 100 + paise;
}

/** Paise to the plain text a rupee input shows, e.g. 149950 -> "1499.50", 149900 -> "1499". */
export function paiseToRupeeInput(paise: number): string {
  const rupees = Math.trunc(paise / 100);
  const rest = paise % 100;
  return rest === 0 ? String(rupees) : `${rupees}.${String(rest).padStart(2, '0')}`;
}
