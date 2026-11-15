// What an implement is and how fast it works. Shared by the farm builder, the live runner and the tests,
// so a tool profile name and width always mean the same thing.
export const TOOLS = {            // implement kind → [AgOpenWeb tool profile name, width in metres]
  sprayer: ['Sprayer 24m', 24],
  mower: ['Mower 9m', 9],
  tiller: ['Tiller 8m', 8],
  seeder: ['Seeder 12m', 12],
};
const SPEED_MPH = { sprayer: 8, mower: 6, tiller: 5, seeder: 5 };

export function kindOf(profileName) {
  return /spray/i.test(profileName) ? 'sprayer' : /mow/i.test(profileName) ? 'mower' :
    /till|disc|disk/i.test(profileName) ? 'tiller' : /seed|plant|drill/i.test(profileName) ? 'seeder' : null;
}

// Acres per hour = width (ft) x speed (mph) x field efficiency / 8.25, the usual field-capacity formula.
export function workRate(kind, widthM) {
  return Math.max(1, Math.round(widthM * 3.281 * SPEED_MPH[kind] * 0.8 / 8.25));
}

// Give scenario tractors their implements from a list of tool profiles [{profile, widthM}] per tractor.
export function applyTools(tractor, profiles, activeProfile) {
  const tools = profiles.map(p => ({ ...p, kind: p.kind ?? kindOf(p.profile) })).filter(p => p.kind && p.widthM);
  if (!tools.length) return null;
  tractor.implements = tools.map(p => p.kind);
  tractor.workRates = Object.fromEntries(tools.map(p => [p.kind, workRate(p.kind, p.widthM)]));
  tractor.mounted = tools.find(p => p.profile === activeProfile)?.kind || tools[0].kind;
  return tools;
}

// The speed a pass is driven at, in km/h (the same speeds the work rates assume).
export function passKph(kind) { return +(SPEED_MPH[kind] * 1.609).toFixed(1); }
