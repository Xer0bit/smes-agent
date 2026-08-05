import { useState } from 'react';
import { DESIGN_TEMPLATES, type DesignTemplate } from '@/data/designTemplates';
import { useLandingContext } from '@/contexts/LandingContext';

const TemplateCard = ({ tpl, active, onHover, onUse }: { tpl: DesignTemplate; active: boolean; onHover: () => void; onUse: () => void }) => {
  const [imgError, setImgError] = useState(false);

  return (
    <div
      className={`tpl-card ${active ? "is-active" : ""}`}
      onMouseEnter={onHover}
      onClick={onUse}
      style={{ "--tpl-bg": tpl.accent, "--tpl-fg": tpl.fg, cursor: "pointer" } as React.CSSProperties}
    >
      <div className="tpl-card__preview">
        <div className="tpl-card__chrome">
          <span className="tpl-card__dots"><i/><i/><i/></span>
          <span className="tpl-card__url">{tpl.id}.preview</span>
        </div>
        {!imgError ? (
          <img
            src={tpl.image}
            alt={`${tpl.name} template preview`}
            className="tpl-card__img"
            loading="lazy"
            decoding="async"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="tpl-card__canvas">
            <div className="tpl-card__brand">{tpl.name}</div>
            <div className="tpl-card__tagline">{tpl.description}</div>
          </div>
        )}
        <div className="tpl-card__pro-badge">Template</div>
      </div>
      <div className="tpl-card__footer">
        <div>
          <div className="tpl-card__name">{tpl.name}</div>
          <div className="tpl-card__tag">{tpl.tag}</div>
        </div>
        <button className="tpl-card__use">Use →</button>
      </div>
    </div>
  );
};

export const TemplateGallery = () => {
  const [active, setActive] = useState(DESIGN_TEMPLATES[0].id);
  const { onUseTemplate } = useLandingContext();

  return (
    <section className="tpl" id="templates">
      <div className="section-head">
        <div className="section-head__num">03</div>
        <div className="section-head__label">TEMPLATES</div>
        <div className="section-head__spacer" />
        <span className="tpl__pro-pill">Included</span>
      </div>
      <div className="tpl__head">
        <h2 className="section-title">
          Start from a template.<br/>
          <span className="section-title__accent">Pixel-perfect design systems from real brands.</span>
        </h2>
        <p className="section-sub">
          Each template passes a complete design spec   typography, colors, spacing, components   to the agent. One click and your site matches the quality of ElevenLabs, Nike, Mintlify, or xAI.
        </p>
      </div>
      <div className="tpl__grid">
        {DESIGN_TEMPLATES.map(tpl => (
          <TemplateCard
            key={tpl.id}
            tpl={tpl}
            active={active === tpl.id}
            onHover={() => setActive(tpl.id)}
            onUse={() => onUseTemplate?.(tpl)}
          />
        ))}
      </div>
    </section>
  );
};
