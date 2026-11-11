// Heuristic blocker for passwords, account numbers and home addresses.
// Applies to every write from humans and bots. Returns null if OK, or a reason string.

function luhn(digits) {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

function ibanValid(raw) {
  const s = raw.replace(/\s+/g, "").toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const re = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of re) {
    const v = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

const SECRET_ASSIGN = /\b(?:pass(?:word|wd|phrase|code)?|pwd|pin|api[ _-]?key|secret[ _-]?key)\b\s*[:=]\s*\S{3,}/i;
const SECRET_IS = /\b(?:pass(?:word|wd|phrase|code)?|pwd|pin|api[ _-]?key)\b\s+(?:is|was)\s+["'`]?(?=\S*[\d\W_])\S{4,}/i;
const ACCOUNT_KEYWORD = /\b(?:account|acct|a\/c|routing|aba|iban|sort\s*code|swift|bic)\b(?:\s*(?:number|no\.?|num|#))?[^\d\n]{0,12}\d[\d -]{3,}\d/i;
const LONG_DIGITS = /(?<![\d.,])\d{8,17}(?![\d.,])/;
const CARD_LIKE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;
const STREET_SUFFIX = "(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Circle|Cir|Parkway|Pkwy|Highway|Hwy|Trail|Trl|Loop|Square|Sq|Alley|Pike|Row)";
const ADDRESS = new RegExp(
  "\\b\\d{1,6}[A-Za-z]?\\s+(?:(?:N|S|E|W|NE|NW|SE|SW|North|South|East|West)\\.?\\s+)?(?:(?:[A-Z][A-Za-z'.-]*|\\d+(?:st|nd|rd|th))\\s+){1,4}" + STREET_SUFFIX + "\\b\\.?",
);
const ADDRESS_LOWER = new RegExp(
  "\\b\\d{1,6}\\s+(?:[a-z]+\\s+){1,3}(?:street|avenue|road|boulevard|lane|drive|court|terrace|parkway)\\b",
);
const PO_BOX = /\bP\.?\s?O\.?\s*Box\s+\d+/i;

export function checkSensitive(...texts) {
  for (const t of texts) {
    if (t == null) continue;
    const s = String(t);
    if (SECRET_ASSIGN.test(s) || SECRET_IS.test(s)) return "it looks like it contains a password, PIN or key";
    if (ACCOUNT_KEYWORD.test(s) || SSN.test(s)) return "it looks like it contains an account or ID number";
    if (LONG_DIGITS.test(s)) return "it contains a long number (8-17 digits) that could be an account number";
    for (const m of s.matchAll(CARD_LIKE)) {
      const d = m[0].replace(/\D/g, "");
      if (d.length >= 13 && d.length <= 19 && luhn(d)) return "it looks like it contains a card number";
    }
    for (const m of s.matchAll(IBAN)) if (ibanValid(m[0])) return "it looks like it contains an IBAN";
    if (ADDRESS.test(s) || ADDRESS_LOWER.test(s) || PO_BOX.test(s)) return "it looks like it contains a street address";
  }
  return null;
}
