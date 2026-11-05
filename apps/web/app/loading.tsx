/** Shown in the panel while a page's data loads (the sidebar stays put); quiet blocks in the usual shapes. */
export default function Loading() {
  return (
    <div className="loading-page" aria-busy="true" aria-label="Loading">
      <div className="page-head">
        <div className="sk sk-line" style={{ width: 140 }} />
      </div>
      <div className="sk-stack">
        <div className="sk sk-title" />
        <div className="sk sk-line" style={{ width: 360, maxWidth: "80%" }} />
      </div>
      <div className="grid fit" style={{ marginTop: 28 }}>
        <div className="sk sk-card" />
        <div className="sk sk-card" />
        <div className="sk sk-card" />
        <div className="sk sk-card" />
      </div>
      <div className="sk sk-card" style={{ marginTop: 16, height: 260 }} />
    </div>
  );
}
