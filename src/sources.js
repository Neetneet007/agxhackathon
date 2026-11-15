// Data-source layer: the feeds the orchestrator fuses before every re-plan.
// Feeds are simulated (scenario.feeds holds a timeline per feed) except
// telematics, which is read live from the simulated tractors.

export const SOURCES = {
  telematics: { name: 'Tractor telematics', detail: 'CAN-bus fuel, position, fault codes', icon: '📡' },
  weather: { name: 'Weather service', detail: 'Hourly forecast for the farm', icon: '🌦' },
  roads: { name: 'Bridge & road feed', detail: 'Water-level gauges, county closures', icon: '🌉' },
  imagery: { name: 'Drone & satellite imagery', detail: 'NDVI crop-stress scouting', icon: '🛰' },
  service: { name: 'Dealer service', detail: 'Repair tickets and ETAs', icon: '🔧' },
  soil: { name: 'Soil-moisture probes', detail: 'Field workability', icon: '💧' },
  operator: { name: 'Operator console', detail: 'Manual changes', icon: '🧑‍🌾' },
};

export const sourceName = id => SOURCES[id]?.name || id;

// Latest reading of every feed at sim time.
export function readFeeds(sim) {
  const feeds = sim.scenario.feeds || {};
  const out = [];
  const tele = sim.tractors.map(t => {
    const pct = Math.round(100 * t.fuel / t.fuelCapacity);
    return `${t.id} ${t.status === 'broken' ? `FAULT ${t.fault || ''}`.trim() : `${pct}% ${t.model?.includes('Electric') ? 'battery' : 'fuel'}`}`;
  });
  out.push({ id: 'telematics', ...SOURCES.telematics, text: tele.join(' · '), alert: sim.tractors.some(t => t.status === 'broken' || t.fuel / t.fuelCapacity < 0.15) });
  for (const id of ['weather', 'roads', 'imagery', 'service', 'soil']) {
    const series = feeds[id] || [];
    const cur = [...series].reverse().find(r => r.t <= sim.time);
    if (cur) out.push({ id, ...SOURCES[id], text: cur.text, alert: !!cur.alert, since: cur.t });
  }
  return out;
}
