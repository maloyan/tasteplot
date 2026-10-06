/**
 * Split a typed list of names. A ";" anywhere makes ";" the separator, so a name
 * may contain commas. Otherwise split on ",", and join a part that starts with a
 * lowercase letter back to the name before it: "Stüssy, Tyler, the Creator" gives
 * ["Stüssy", "Tyler, the Creator"]. Names in a list start with a capital or a digit.
 */
export function splitNames(s: string): string[] {
  const parts = s.includes(";") ? s.split(";") : s.split(",");
  const out: string[] = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    if (!s.includes(";") && out.length && /^\p{Ll}/u.test(p)) out[out.length - 1] += `, ${p}`;
    else out.push(p);
  }
  return out;
}
