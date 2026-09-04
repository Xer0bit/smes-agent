import BrandLoader from "@/components/BrandLoader";

export default function Changelog() {
  return (
    <>
      <section className="smes-site-section" style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="smes-site-section__inner" style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: "var(--smes-site-space-8)" }}>
          <BrandLoader variant="sonar" size={120} label="Changelog" />
          <div>
            <h1 style={{ margin: 0, fontSize: "var(--smes-site-text-3xl)", fontWeight: 500, letterSpacing: "-0.02em" }}>Changelog</h1>
            <p style={{ margin: "var(--smes-site-space-4) 0 0", color: "var(--smes-site-muted)", fontSize: "var(--smes-site-text-lg)", maxWidth: "32rem" }}>
              Product updates, new features, and improvements. We publish here every time we ship something meaningful.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
