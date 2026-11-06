/** Text helpers shared by the safety screen and the interpreter. */

export function normalize(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[​-‍﻿]/g, '')
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits a message into sentence-like clauses so one message can carry several intents. */
export function splitClauses(normalized: string): string[] {
  return normalized
    .split(/(?<=[.!?;])\s+|\n+|\s+(?:and also|also,?|plus,?)\s+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

export interface BpReading {
  systolic: number;
  diastolic: number;
  text: string;
}

/** Blood-pressure readings such as "150/95" or "150 over 95" (plausibility-checked). */
export function extractReadings(normalized: string): BpReading[] {
  const out: BpReading[] = [];
  for (const m of normalized.matchAll(/(?<![\d/])(\d{2,3})\s*(?:\/|over)\s*(\d{2,3})(?![\d/])/g)) {
    const systolic = Number(m[1]);
    const diastolic = Number(m[2]);
    if (systolic >= 70 && systolic <= 300 && diastolic >= 30 && diastolic <= 200 && systolic > diastolic) {
      out.push({ systolic, diastolic, text: `${systolic}/${diastolic}` });
    }
  }
  return out;
}

/** Ends a sentence with a period unless it already ends with one (e.g. "... 2:00 p.m."). */
export function period(s: string): string {
  return /[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`;
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

export function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

export function formatMoney(amount: number): string {
  return `$${amount.toFixed(2)}`;
}
