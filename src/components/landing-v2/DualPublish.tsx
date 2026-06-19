import { useState } from 'react';

export const DualPublish = () => {
  const [side, setSide] = useState<'global' | 'china'>('global');

  const globalSite = (
    <div className="mock mock--global">
      <div className="mock__bar">
        <span className="mock__dots"><i /><i /><i /></span>
        <span className="mock__url">yourbrand.com</span>
        <span className="mock__region">🌐 EN</span>
      </div>
      <div className="mock__body">
        <div className="mock__nav">
          <span>Shop</span><span>Story</span><span>Journal</span><span className="mock__cart">Bag · 0</span>
        </div>
        <div className="mock__hero">
          <div className="mock__hero-eyebrow">CERAMIC STUDIO · EST. 2024</div>
          <div className="mock__hero-title">Hand-thrown tableware,<br />made for slow mornings.</div>
          <div className="mock__hero-cta">Shop the collection →</div>
        </div>
        <div className="mock__grid">
          {[1, 2, 3].map(i => (
            <div key={i} className="mock__product">
              <div className="mock__product-img" data-num={i} />
              <div className="mock__product-row">
                <span>Hiraeth Mug</span><span>$42</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  const chinaSite = (
    <div className="mock mock--china">
      <div className="mock__bar">
        <span className="mock__dots"><i /><i /><i /></span>
        <span className="mock__url">yourbrand.cn</span>
        <span className="mock__region">🇨🇳 中文</span>
      </div>
      <div className="mock__body mock__body--cn">
        <div className="mock__nav">
          <span>商城</span><span>品牌故事</span><span>日志</span><span className="mock__cart">购物袋 · 0</span>
        </div>
        <div className="mock__hero">
          <div className="mock__hero-eyebrow">陶艺工作室 · 2024 年创立</div>
          <div className="mock__hero-title">手工陶器，<br />为慢节奏的清晨。</div>
          <div className="mock__hero-cta">浏览全系列 →</div>
        </div>
        <div className="mock__grid">
          {[1, 2, 3].map(i => (
            <div key={i} className="mock__product">
              <div className="mock__product-img" data-num={i} />
              <div className="mock__product-row">
                <span>Hiraeth 马克杯</span><span>¥298</span>
              </div>
            </div>
          ))}
        </div>
        <div className="mock__china-badges">
          <span>ICP备案</span><span>微信支付</span><span>支付宝</span>
        </div>
      </div>
    </div>
  );

  return (
    <section className="dual" id="china">
      <div className="section-head">
        <div className="section-head__num">02</div>
        <div className="section-head__label">DUAL-PUBLISH</div>
        <div className="section-head__spacer" />
      </div>
      <div className="dual__headline">
        <h2 className="section-title">
          One source of truth.<br />
          <span className="section-title__accent">Two markets. 两个市场.</span>
        </h2>
        <p className="section-sub">
          Every SKU, page, and policy is published to the global web and the China mainland at the same time — with the right domain, CDN, payment rails, and language for each.
        </p>
      </div>
      <div className="dual__stage">
        <div className="dual__toggle">
          <button
            className={`dual__toggle-btn ${side === 'global' ? 'is-active' : ''}`}
            onClick={() => setSide('global')}
          >Global · EN</button>
          <button
            className={`dual__toggle-btn ${side === 'china' ? 'is-active' : ''}`}
            onClick={() => setSide('china')}
          >中国 · 中文</button>
          <div className={`dual__toggle-pill dual__toggle-pill--${side}`} />
        </div>
        <div className="dual__mocks">
          <div className={`dual__mock-wrap ${side === 'global' ? 'is-front' : ''}`}>
            {globalSite}
          </div>
          <div className={`dual__mock-wrap ${side === 'china' ? 'is-front' : ''}`}>
            {chinaSite}
          </div>
        </div>
        <div className="dual__pipeline">
          <div className="pipe-node">
            <div className="pipe-node__label">SOURCE</div>
            <div className="pipe-node__name">brand.workspace</div>
          </div>
          <div className="pipe-arrow">→</div>
          <div className="pipe-node pipe-node--agent">
            <div className="pipe-node__label">
              <span className="pipe-node__pulse" />AGENT
            </div>
            <div className="pipe-node__name">localize · format · route</div>
          </div>
          <div className="pipe-arrow pipe-arrow--split">
            <span>↗</span><span>↘</span>
          </div>
          <div className="pipe-outputs">
            <div className="pipe-output">
              <span className="pipe-output__flag">🌐</span>
              <span>yourbrand.com</span>
              <span className="pipe-output__status">live</span>
            </div>
            <div className="pipe-output">
              <span className="pipe-output__flag">🇨🇳</span>
              <span>yourbrand.cn</span>
              <span className="pipe-output__status">live</span>
            </div>
            <div className="pipe-output">
              <span className="pipe-output__flag">💬</span>
              <span>WeChat Mini</span>
              <span className="pipe-output__status">live</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
