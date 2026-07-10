"use client";

import { useState } from "react";

const reports = [
  { id: 1, x: 24, y: 27, size: 94, species: "Mallard", count: "25–50", age: "12m", color: "green", confidence: 92 },
  { id: 2, x: 63, y: 20, size: 66, species: "Teal", count: "10–25", age: "28m", color: "blue", confidence: 84 },
  { id: 3, x: 73, y: 58, size: 108, species: "Mixed ducks", count: "50+", age: "41m", color: "gold", confidence: 88 },
  { id: 4, x: 36, y: 70, size: 55, species: "Gadwall", count: "1–10", age: "1h", color: "gray", confidence: 71 },
];

const Icon = ({ children }: { children: React.ReactNode }) => <span className="icon" aria-hidden="true">{children}</span>;

export default function Home() {
  const [selected, setSelected] = useState(reports[0]);
  const [panel, setPanel] = useState<"map" | "feed" | "saved">("map");
  const [reporting, setReporting] = useState(false);
  const [sent, setSent] = useState(false);
  const [species, setSpecies] = useState("Mallard");
  const [amount, setAmount] = useState("25–50");

  const submit = () => { setSent(true); setTimeout(() => { setReporting(false); setSent(false); }, 1400); };

  return (
    <main className="app-shell">
      <section className="map" aria-label="Duck activity map">
        <div className="terrain" />
        <div className="river river-one" /><div className="river river-two" />
        <div className="road r1" /><div className="road r2" />
        <span className="place p1">GRASSY LAKE WMA</span><span className="place p2">OLD RIVER</span><span className="place p3">NORTH MARSH</span>

        <header className="topbar">
          <div className="brand"><div className="brandmark">F</div><div><strong>FLYWAY</strong><span>DUCK ACTIVITY, NOT HUNTING SPOTS</span></div></div>
          <button className="area"><Icon>⌖</Icon><span><small>VIEWING</small>Lower Mississippi Flyway</span><b>⌄</b></button>
          <div className="weather"><span>☁</span><div><b>43°</b><small>NW 12 mph · Rising pressure</small></div></div>
          <button className="avatar" aria-label="Profile">RW</button>
        </header>

        <aside className="filters">
          <button className="filter active">All ducks</button><button className="filter">Dabblers</button><button className="filter">Divers</button>
          <button className="round" aria-label="Map layers">▱</button>
        </aside>

        {reports.map(r => <button key={r.id} onClick={() => setSelected(r)} className={`hotspot ${r.color} ${selected.id === r.id ? "selected" : ""}`} style={{ left: `${r.x}%`, top: `${r.y}%`, width: r.size, height: r.size }} aria-label={`${r.species}, ${r.count}, ${r.age} ago`}><span>{r.count}</span></button>)}

        <button className="locate" aria-label="Center on my location">⌖</button>

        <section className="report-card">
          <button className="close-card" aria-label="Close">×</button>
          <div className="report-head"><div className={`duck-badge ${selected.color}`}>⌁</div><div><span className="eyebrow">RECENT ACTIVITY · {selected.age.toUpperCase()} AGO</span><h2>{selected.species}</h2></div><div className="confidence"><b>{selected.confidence}%</b><span>CONFIDENCE</span></div></div>
          <div className="stats"><div><span>ESTIMATED FLOCK</span><strong>{selected.count} birds</strong></div><div><span>BEHAVIOR</span><strong>Feeding &amp; circling</strong></div><div><span>TREND</span><strong className="up">↗ Building</strong></div></div>
          <div className="privacy"><Icon>◉</Icon><span><b>Location protected</b>This report is blurred across a 3-mile zone. The hunter’s exact spot is never shown.</span></div>
          <div className="confirm"><span>Seen them too?</span><button>Not now</button><button className="confirm-btn">✓ Confirm activity</button></div>
        </section>

        <nav className="bottom-nav" aria-label="Main navigation">
          <button className={panel === "map" ? "active" : ""} onClick={() => setPanel("map")}><Icon>⌖</Icon>Map</button>
          <button className={panel === "feed" ? "active" : ""} onClick={() => setPanel("feed")}><Icon>≡</Icon>Activity</button>
          <button className="report-button" onClick={() => setReporting(true)}><span>＋</span>Report ducks</button>
          <button className={panel === "saved" ? "active" : ""} onClick={() => setPanel("saved")}><Icon>♧</Icon>Saved</button>
          <button><Icon>◌</Icon>More</button>
        </nav>
      </section>

      {reporting && <div className="modal-wrap" role="dialog" aria-modal="true" aria-labelledby="report-title">
        <div className="modal">
          {sent ? <div className="success"><div>✓</div><h2>Activity shared</h2><p>Your exact location stays private.</p></div> : <>
            <div className="modal-head"><div><span className="eyebrow">COMMUNITY SIGHTING</span><h2 id="report-title">Report duck activity</h2></div><button onClick={() => setReporting(false)} aria-label="Close">×</button></div>
            <div className="shield"><span>◉</span><div><b>Your location will be blurred</b><p>Hunters see a randomized 3-mile activity zone—not your pin, route, or blind.</p></div></div>
            <label>What did you see?</label><div className="choice-grid">{["Mallard","Teal","Gadwall","Mixed ducks"].map(s => <button className={species === s ? "active" : ""} onClick={() => setSpecies(s)} key={s}>{s}</button>)}</div>
            <label>How many?</label><div className="choice-grid four">{["1–10","10–25","25–50","50+"].map(a => <button className={amount === a ? "active" : ""} onClick={() => setAmount(a)} key={a}>{a}</button>)}</div>
            <label>What were they doing?</label><select defaultValue="Feeding & circling"><option>Feeding &amp; circling</option><option>Flying over</option><option>Resting on water</option><option>Moving into area</option></select>
            <button className="share" onClick={submit}>Share protected report <span>→</span></button>
            <p className="fine">Reports fade after 6 hours. Repeated false reports reduce account trust.</p>
          </>}
        </div>
      </div>}
    </main>
  );
}
