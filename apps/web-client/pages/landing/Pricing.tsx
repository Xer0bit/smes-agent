/**
 * Landing → Pricing: one plan, priced by unit.
 *
 *   SINGLE  $19/mo   includes 1 App · 1 Agent · 1 User · 1 Database · OneNET · OneMAIL
 *   + $19/mo per additional App, User, Agent or Database
 *
 * The estimator reads the same price list the product enforces
 * (GET /api/v1/plan/catalog) and falls back to the defaults if the API is
 * unreachable so the page never renders empty.
 */
import { useEffect, useMemo, useState } from "react";
import { Check, Minus, Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { FaqSection } from "@/components/landing/FaqSection";
import { useLandingContext } from "@/contexts/LandingContext";
import {
  DEFAULT_CATALOG, fetchPublicCatalog, formatDollars, includedQuantity, unitPriceCents,
  UNITS, UNIT_LABELS, type Catalog, type Unit,
} from "@/services/planService";

const UNIT_BLURB: Record<Unit, string> = {
  apps: "Each app is its own project with hosting, preview and publish.",
  users: "Teammates who can open the workspace and talk to the agent.",
  agents: "Extra eCG agents running on your own data and keys.",
  databases: "A dedicated hosted Postgres schema with REST access.",
};

const BASE_FEATURES = [
  "AI agent that builds and ships the app",
  "Hosting, preview and publish included",
  "Hosted database with REST API",
  "Edge functions for auth and integrations",
  "OneNET and OneMAIL",
  "Fair-use agent work per app",
];

export default function Pricing() {
  const { user, onLoginClick } = useLandingContext();
  const navigate = useNavigate();
  const [catalog, setCatalog] = useState<Catalog>(DEFAULT_CATALOG);
  const [qty, setQty] = useState<Record<Unit, number>>({ apps: 1, users: 1, agents: 1, databases: 1 });

  useEffect(() => {
    fetchPublicCatalog().then((c) => {
      setCatalog(c);
      setQty({ apps: c.included_apps, users: c.included_users, agents: c.included_agents, databases: c.included_databases });
    }).catch(() => { /* defaults stay */ });
  }, []);

  const estimate = useMemo(() => {
    const lines = UNITS.map((unit) => {
      const extra = Math.max(0, qty[unit] - includedQuantity(catalog, unit));
      return { unit, extra, amount: extra * unitPriceCents(catalog, unit) };
    });
    return { lines, total: catalog.base_price_cents + lines.reduce((n, l) => n + l.amount, 0) };
  }, [catalog, qty]);

  const start = () => {
    if (user) navigate("/dashboard/settings?section=workspace-plans");
    else onLoginClick();
  };

  return (
    <>
      <section className="pricing" id="pricing">
        <div className="pricing__single">
          <div className="plan plan--highlight">
            <div className="plan__tag">One plan</div>
            <div className="plan__name">{catalog.name}</div>
            <div className="plan__price">
              <span className="plan__currency">$</span>
              <span className="plan__num">{Math.round(catalog.base_price_cents / 100)}</span>
              <span className="plan__cadence">/mo</span>
            </div>
            <div className="plan__blurb">
              Includes {catalog.included_apps} App · {catalog.included_agents} Agent · {catalog.included_users} User · {catalog.included_databases} Database · {catalog.includes.join(" · ")}
            </div>
            <ul className="plan__features">
              {BASE_FEATURES.map((f) => (
                <li key={f}><Check size={12} />{f}</li>
              ))}
            </ul>
            <button className="plan__cta" onClick={start} type="button">Start with SINGLE</button>
          </div>

          <div className="calc">
            <div className="calc__title">Estimate Monthly Cost</div>
            <div className="calc__sub">Add what you need. Every unit is {formatDollars(catalog.app_price_cents)}/mo, drop it any time.</div>

            <div className="calc__row calc__row--base">
              <div>
                <div className="calc__label">{catalog.name}</div>
                <div className="calc__hint">Includes 1 of everything below</div>
              </div>
              <div className="calc__amount">{formatDollars(catalog.base_price_cents)}</div>
            </div>

            {UNITS.map((unit) => {
              const included = includedQuantity(catalog, unit);
              const line = estimate.lines.find((l) => l.unit === unit)!;
              return (
                <div key={unit} className="calc__row">
                  <div>
                    <div className="calc__label">Additional {UNIT_LABELS[unit].plural} <span className="calc__price">× {formatDollars(unitPriceCents(catalog, unit))}/mo</span></div>
                    <div className="calc__hint">{UNIT_BLURB[unit]}</div>
                  </div>
                  <div className="calc__ctl">
                    <div className="calc__stepper">
                      <button type="button" aria-label={`Remove ${UNIT_LABELS[unit].singular}`} disabled={qty[unit] <= included} onClick={() => setQty({ ...qty, [unit]: qty[unit] - 1 })}><Minus size={14} /></button>
                      <span>{qty[unit]}</span>
                      <button type="button" aria-label={`Add ${UNIT_LABELS[unit].singular}`} onClick={() => setQty({ ...qty, [unit]: qty[unit] + 1 })}><Plus size={14} /></button>
                    </div>
                    <div className="calc__amount">{line.extra > 0 ? formatDollars(line.amount) : "included"}</div>
                  </div>
                </div>
              );
            })}

            <div className="calc__total">
              <div>
                <div className="calc__label">Monthly total</div>
                <div className="calc__hint">
                  Base {formatDollars(catalog.base_price_cents)}
                  {estimate.lines.filter((l) => l.extra > 0).map((l) => ` + ${l.extra} ${l.extra === 1 ? UNIT_LABELS[l.unit].singular : UNIT_LABELS[l.unit].plural} ${formatDollars(l.amount)}`).join("")}
                </div>
              </div>
              <div className="calc__sum">{formatDollars(estimate.total)}<span>/mo</span></div>
            </div>

            <button className="plan__cta plan__cta--primary calc__cta" onClick={start} type="button">
              Start at {formatDollars(estimate.total)}/mo
            </button>
            <div className="calc__foot">Fair use: {catalog.included_eco_per_app} eco of agent work per app per month. Cancel any unit any time.</div>
          </div>
        </div>
      </section>

      <FaqSection />
    </>
  );
}
