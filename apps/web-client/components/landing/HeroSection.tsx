import { useState, useEffect, useMemo } from "react";
import Hyperspeed from "./Hyperspeed";



interface HeroSectionProps {
  onLaunch: () => void;
}

export const HeroSection = ({ onLaunch }: HeroSectionProps) => {
  const copy = {
    h1a: "Hire an Agent,",
    h1b: "Not an Agency.",
    sub: "Ecomgear is the autonomous operator for small businesses going global. One prompt and an agent ships your storefront to the world and to China, at the same time.",
  };

  const hyperspeedOptions = useMemo(() => ({
    distortion: 'turbulentDistortion',
    length: 400,
    roadWidth: 10,
    islandWidth: 2,
    lanesPerRoad: 3,
    fov: 90,
    fovSpeedUp: 150,
    speedUp: 2,
    carLightsFade: 0.4,
    totalSideLightSticks: 20,
    lightPairsPerRoadWay: 40,
    colors: {
      roadColor: 0x080808,
      islandColor: 0x0a0a0a,
      background: 0x000000,
      shoulderLines: 0xffffff,
      brokenLines: 0xffffff,
      leftCars: [0x6366f1, 0x4f46e5, 0x818cf8],
      rightCars: [0x06b6d4, 0x0891b2, 0x22d3ee],
      sticks: 0x6366f1,
    },
  }), []);

  return (
    <section className="hero hero--default" id="product">
      {/* Hyperspeed WebGL background */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 0, opacity: 0.45, pointerEvents: 'none' }}>
        <Hyperspeed effectOptions={hyperspeedOptions} />
      </div>
      <div className="hero__inner">

        <h1 className="hero__title">
          <span className="hero__title-line">{copy.h1a}</span>
          <span className="hero__title-line hero__title-line--accent">
            {copy.h1b}
          </span>
        </h1>
        <p className="hero__sub">{copy.sub}</p>
        <div className="hero__cta">
          <button className="btn btn--primary" onClick={onLaunch}>
            Launch with an agent
            <svg width="14" height="14" viewBox="0 0 14 14">
              <path
                d="M3 7H11M11 7L7 3M11 7L7 11"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
        <div className="hero__meta">
          <div className="hero__meta-item">
            <span className="hero__meta-num">12k+</span>
            <span className="hero__meta-label">SMEs launched</span>
          </div>
          <div className="hero__meta-divider" />
          <div className="hero__meta-item">
            <span className="hero__meta-num">47</span>
            <span className="hero__meta-label">markets · incl. 中国</span>
          </div>
          <div className="hero__meta-divider" />
          <div className="hero__meta-item">
            <span className="hero__meta-num">~4min</span>
            <span className="hero__meta-label">avg. time to publish</span>
          </div>
        </div>
      </div>

    </section>
  );
};
