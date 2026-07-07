const TIER_1 = [
  /(?<=^|[\s.-])(QxR|afm72|Bandi|FreetheFish|Garshasp|Ghost|Ime|Kappa|Langbard|LION|Panda|MONOLITH|Natty|r00t|RCVR|RZeroX|SAMPA|Silence|t3nzin|Tigole|YOGI)\b/i,
  /(?<=^|[\s.-])(TAoE|Ainz|AJJMIN|ANONAZ|ArcX|bccornfo|DNU|DrainedDay|DUHIT|Erie|Frys|Goki|HxD|jb2049|JBENT|Nostradamus|r0b0t|Species180|TheSickle|xtrem3x|WEM|POIASD)\b/i,
  /(?<=^|[\s.-])SARTRE\b/i
]

const TIER_2 = [
  /(?<=^|[\s.-])R1GY3B\b/i,
  /(?<=^|[\s.-])Ralphy\b/i,
  /(?<=^|[\s.-])TimeDistortion\b/i,
  /(?<=^|[\s.-])SQS\b/i,
  /(?<=^|[\s.-])Chivaman\b/i,
  /(?<=^|[\s.-])Vyndros\b/i,
  /(?<=^|[\s.-])Prof\b/i,
  /(?<=^|[\s.-])HeVK\b/i,
  /(?<=^|[\s.-])(UTR|Joy|Q22|ImE|Qman|Q18|Ime|theincognito)\b/i,
  /(?<=^|[\s.-])Korach\b/i,
  /(?<=^|[\s.-])D0ct0rLew\b/i,
  /(?<=^|[\s.-])SM737\b/i
]

const TIER_3 = [
  /(?<=^|[\s.-])iVy\b/i,
  /(?<=^|[\s.-])KONTRAST\b/i,
  /(?<=^|[\s.-])PHOCiS\b/i,
  /(?<=^|[\s.-])YAWNiX\b/i,
  /(?<=^|[\s.-])edge2020\b/i,
  /(?<=^|[\s.-])YIFY\b/i,
  /(?<=^|[\s.-])PSA\b/i,
  /(?<=^|[\s.-])MeGusta\b/i
]

export interface ScoredRelease {
  tier: number // 1, 2, 3 or 0 (no match)
  score: number
}

export const TIER_1_TERMS = ['QxR', 'Tigole', 'Bandi', 'Ghost', 'Kappa', 'SAMPA', 'Silence', 't3nzin', 'YOGI', 'TAoE', 'Ainz', 'ANONAZ', 'xtrem3x']
export const TIER_2_TERMS = ['UTR', 'Joy', 'Qman', 'theincognito', 'Korach', 'D0ct0rLew']
export const TIER_3_TERMS = ['YIFY', 'PSA', 'MeGusta']

export function scoreRelease(title: string): ScoredRelease {
  if (TIER_1.some(regex => regex.test(title))) {
    return { tier: 1, score: 1000 }
  }
  if (TIER_2.some(regex => regex.test(title))) {
    return { tier: 2, score: 500 }
  }
  if (TIER_3.some(regex => regex.test(title))) {
    return { tier: 3, score: 100 }
  }
  return { tier: 0, score: 0 }
}
