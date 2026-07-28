const ITEMS = [
  "Ceramic · Studio Hiraeth",
  "Beauty · Palm & Peony",
  "Hardware · Circuit Lab",
  "Tea · 云栖茶庄",
  "Fashion · Atlas Objects",
  "Snacks · Weekday Market",
  "Skincare · 棕榈与牡丹",
  "Stationery · Nib & Paper",
  "Coffee · Dawn Roasters",
  "瓷器 · 磐石器物",
];

export function LandingMarquee() {
  return (
    <div className="marquee">
      <div className="marquee__track">
        {[...ITEMS, ...ITEMS].map((item, i) => (
          <span key={i} className="marquee__item">
            <span className="marquee__dot">◆</span> {item}
          </span>
        ))}
      </div>
      <div className="marquee__label">LAUNCHED WITH ECOMGEAR</div>
    </div>
  );
}
