/**
 * Identify a license from LICENSE file text. Order matters: GPL texts contain
 * the word "permitted", so naive substring checks for "mit" misfire.
 */
export function detectLicenseFromText(text: string): string | null {
  const t = text.slice(0, 3000).toLowerCase().replace(/\s+/g, ' ');
  if (t.includes('gnu affero general public license')) return 'AGPL-3.0';
  if (t.includes('gnu lesser general public license')) return t.includes('version 2.1') ? 'LGPL-2.1' : 'LGPL-3.0';
  if (t.includes('gnu general public license')) return t.includes('version 2') && !t.includes('version 3') ? 'GPL-2.0' : 'GPL-3.0';
  if (t.includes('mozilla public license')) return 'MPL-2.0';
  if (t.includes('apache license')) return 'Apache-2.0';
  if (t.includes('mit license') || t.includes('permission is hereby granted, free of charge')) return 'MIT';
  if (t.includes('redistribution and use in source and binary forms')) return t.includes('neither the name') ? 'BSD-3-Clause' : 'BSD-2-Clause';
  if (t.includes('this is free and unencumbered software released into the public domain')) return 'Unlicense';
  if (t.includes('isc license')) return 'ISC';
  return null;
}

export type LicenseFamily = 'permissive' | 'weak-copyleft' | 'strong-copyleft' | 'network-copyleft' | 'unknown';

export function licenseFamily(spdx: string | null | undefined): LicenseFamily {
  if (!spdx) return 'unknown';
  const s = spdx.toUpperCase();
  if (s.startsWith('AGPL')) return 'network-copyleft';
  if (s.startsWith('GPL')) return 'strong-copyleft';
  if (s.startsWith('LGPL') || s.startsWith('MPL') || s.startsWith('EPL')) return 'weak-copyleft';
  if (['MIT', 'ISC', 'UNLICENSE', '0BSD', 'CC0-1.0', 'ZLIB'].includes(s) || s.startsWith('BSD') || s.startsWith('APACHE')) return 'permissive';
  return 'unknown';
}

export interface LicenseVerdict {
  verdict: 'compatible' | 'caution' | 'conflict';
  reason: string;
}

/**
 * Can code under `dependency` be pulled into a project under `project`?
 * Coarse rules for flagging, not legal advice.
 */
export function licenseCompatibility(project: string | null, dependency: string | null): LicenseVerdict {
  const dep = licenseFamily(dependency);
  const proj = licenseFamily(project);
  if (dep === 'unknown') return { verdict: 'caution', reason: `Dependency license '${dependency ?? 'none'}' is unknown or missing; without a license you have no right to reuse the code.` };
  if (dep === 'permissive') return { verdict: 'compatible', reason: `${dependency} is permissive; keep its copyright notice.` };
  if (dep === 'weak-copyleft') return { verdict: 'caution', reason: `${dependency} is weak copyleft: modifications to its files must stay open, but linking from other code is generally allowed.` };
  if (proj === 'strong-copyleft' || proj === 'network-copyleft') {
    if (dep === 'network-copyleft' && proj !== 'network-copyleft') return { verdict: 'caution', reason: `${dependency} adds network-use obligations beyond ${project}.` };
    return { verdict: 'compatible', reason: `Both projects are copyleft (${project} / ${dependency}); check version compatibility (e.g. GPL-2.0-only vs GPL-3.0).` };
  }
  return { verdict: 'conflict', reason: `${dependency} is ${dep}; distributing it inside a ${project ?? 'unlicensed/proprietary'} project would require relicensing the combined work under ${dependency}.` };
}
