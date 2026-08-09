/**
 * Premium Template Library
 * Pre-built templates for common web applications.
 */

import { TemplateFile } from './templateLoader';

export interface ProjectTemplate {
    id: string;
    name: string;
    description: string;
    category: 'landing' | 'dashboard' | 'ecommerce' | 'blog' | 'portfolio';
    thumbnail: string;
    tags: string[];
    files: TemplateFile[];
}

// ============================================================================
// SAAS LANDING PAGE TEMPLATE
// ============================================================================

const SAAS_LANDING_APP = `import React from 'react';
import './App.css';

const App = () => {
  return (
    <div className="app">
      {/* Navigation */}
      <nav className="navbar">
        <div className="nav-container">
          <div className="logo">YourBrand</div>
          <div className="nav-links">
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <a href="#testimonials">Testimonials</a>
          </div>
          <button className="btn btn-primary">Get Started</button>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="hero">
        <div className="hero-content">
          <h1>Your Product Name</h1>
          <p>A clear description of what your product does and who it's for.</p>
          <div className="hero-buttons">
            <button className="btn btn-primary btn-large">Get Started</button>
            <button className="btn btn-secondary btn-large">Learn More</button>
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="features">
        <div className="section-header">
          <h2>Features</h2>
          <p>Key capabilities of your product.</p>
        </div>
        <div className="features-grid">
          {[
            { title: 'Analytics', desc: 'Track and visualize your data.' },
            { title: 'Collaboration', desc: 'Work with your team.' },
            { title: 'Automation', desc: 'Automate repetitive tasks.' },
            { title: 'Security', desc: 'Keep your data safe.' },
            { title: 'Integrations', desc: 'Connect with other tools.' },
            { title: 'Support', desc: 'Get help when you need it.' },
          ].map((feature, i) => (
            <div key={i} className="feature-card">
              <div className="feature-icon">{i + 1}</div>
              <h3>{feature.title}</h3>
              <p>{feature.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing Section */}
      <section id="pricing" className="pricing">
        <div className="section-header">
          <h2>Simple, transparent pricing</h2>
          <p>Choose the plan that works for you.</p>
        </div>
        <div className="pricing-grid">
          {[
            { name: 'Starter', price: '$9', features: ['5 Projects', '10GB Storage', 'Email Support'] },
            { name: 'Pro', price: '$29', features: ['Unlimited Projects', '100GB Storage', 'Priority Support', 'API Access'], popular: true },
            { name: 'Enterprise', price: '$99', features: ['Everything in Pro', 'Unlimited Storage', 'Dedicated Support', 'Custom Integrations'] },
          ].map((plan, i) => (
            <div key={i} className={\`pricing-card \${plan.popular ? 'popular' : ''}\`}>
              {plan.popular && <span className="badge">Most Popular</span>}
              <h3>{plan.name}</h3>
              <div className="price">{plan.price}<span>/month</span></div>
              <ul>
                {plan.features.map((f, j) => <li key={j}>{f}</li>)}
              </ul>
              <button className="btn btn-primary">Get Started</button>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="footer">
        <div className="footer-container">
          <div className="footer-brand">
            <div className="logo">YourBrand</div>
            <p>Your tagline here.</p>
          </div>
          <div className="footer-links">
            <div><h4>Product</h4><a href="#">Features</a><a href="#">Pricing</a><a href="#">Integrations</a></div>
            <div><h4>Company</h4><a href="#">About</a><a href="#">Blog</a><a href="#">Careers</a></div>
            <div><h4>Support</h4><a href="#">Help Center</a><a href="#">Contact</a><a href="#">Status</a></div>
          </div>
        </div>
        <div className="footer-bottom">
          <p>&copy; 2024 YourBrand. All rights reserved.</p>
        </div>
      </footer>
    </div>
  );
};

export default App;`;

const SAAS_LANDING_CSS = `/* SaaS Landing Page Styles */
:root {
  --primary: #6366f1;
  --primary-dark: #4f46e5;
  --secondary: #8b5cf6;
  --gray-50: #f9fafb;
  --gray-100: #f3f4f6;
  --gray-200: #e5e7eb;
  --gray-600: #4b5563;
  --gray-800: #1f2937;
  --gray-900: #111827;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Inter', sans-serif; line-height: 1.6; color: var(--gray-800); }

/* Navbar */
.navbar {
  position: fixed;
  top: 0;
  width: 100%;
  background: rgba(255,255,255,0.95);
  backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--gray-200);
  z-index: 100;
}
.nav-container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 1rem 2rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.logo { font-size: 1.5rem; font-weight: 700; color: var(--primary); }
.nav-links { display: flex; gap: 2rem; }
.nav-links a { color: var(--gray-600); text-decoration: none; transition: color 0.2s; }
.nav-links a:hover { color: var(--primary); }

/* Buttons */
.btn {
  padding: 0.75rem 1.5rem;
  border-radius: 8px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  border: none;
}
.btn-primary {
  background: linear-gradient(135deg, var(--primary), var(--secondary));
  color: white;
}
.btn-primary:hover { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(99,102,241,0.4); }
.btn-secondary {
  background: transparent;
  border: 2px solid var(--primary);
  color: var(--primary);
}
.btn-large { padding: 1rem 2rem; font-size: 1.1rem; }

/* Hero */
.hero {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  padding: 6rem 2rem;
}
.hero-content { max-width: 800px; text-align: center; color: white; }
.hero h1 { font-size: 3.5rem; font-weight: 800; margin-bottom: 1.5rem; line-height: 1.1; }
.hero p { font-size: 1.25rem; opacity: 0.9; margin-bottom: 2rem; }
.hero-buttons { display: flex; gap: 1rem; justify-content: center; margin-bottom: 1rem; }
.hero-subtext { font-size: 0.9rem; opacity: 0.7; }

/* Sections */
.section-header { text-align: center; margin-bottom: 4rem; }
.section-header h2 { font-size: 2.5rem; margin-bottom: 1rem; }
.section-header p { color: var(--gray-600); font-size: 1.1rem; }

/* Features */
.features { padding: 6rem 2rem; background: var(--gray-50); }
.features-grid {
  max-width: 1200px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 2rem;
}
.feature-card {
  background: white;
  padding: 2rem;
  border-radius: 16px;
  box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1);
  transition: transform 0.2s;
}
.feature-card:hover { transform: translateY(-4px); }
.feature-icon {
  width: 48px;
  height: 48px;
  background: linear-gradient(135deg, var(--primary), var(--secondary));
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: 700;
  margin-bottom: 1rem;
}
.feature-card h3 { margin-bottom: 0.5rem; }
.feature-card p { color: var(--gray-600); }

/* Pricing */
.pricing { padding: 6rem 2rem; }
.pricing-grid {
  max-width: 1000px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 2rem;
}
.pricing-card {
  background: white;
  padding: 2rem;
  border-radius: 16px;
  border: 1px solid var(--gray-200);
  text-align: center;
  position: relative;
}
.pricing-card.popular {
  border: 2px solid var(--primary);
  box-shadow: 0 8px 24px rgba(99,102,241,0.2);
}
.badge {
  position: absolute;
  top: -12px;
  left: 50%;
  transform: translateX(-50%);
  background: var(--primary);
  color: white;
  padding: 0.25rem 1rem;
  border-radius: 9999px;
  font-size: 0.8rem;
}
.price { font-size: 3rem; font-weight: 700; margin: 1rem 0; }
.price span { font-size: 1rem; color: var(--gray-600); }
.pricing-card ul { list-style: none; margin: 2rem 0; text-align: left; }
.pricing-card li { padding: 0.5rem 0; color: var(--gray-600); }
.pricing-card li::before { content: "✓"; color: var(--primary); margin-right: 0.5rem; }

/* Footer */
.footer { background: var(--gray-900); color: white; padding: 4rem 2rem 2rem; }
.footer-container {
  max-width: 1200px;
  margin: 0 auto;
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 4rem;
}
.footer-brand p { color: var(--gray-600); margin-top: 1rem; }
.footer-links { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2rem; }
.footer-links h4 { margin-bottom: 1rem; }
.footer-links a { display: block; color: var(--gray-600); text-decoration: none; padding: 0.25rem 0; }
.footer-links a:hover { color: white; }
.footer-bottom { border-top: 1px solid var(--gray-800); margin-top: 3rem; padding-top: 2rem; text-align: center; color: var(--gray-600); }

/* Responsive */
@media (max-width: 768px) {
  .nav-links { display: none; }
  .hero h1 { font-size: 2.5rem; }
  .hero-buttons { flex-direction: column; }
  .footer-container { grid-template-columns: 1fr; }
  .footer-links { grid-template-columns: 1fr; }
}`;

// ============================================================================
// DASHBOARD TEMPLATE
// ============================================================================

const DASHBOARD_APP = `import React, { useState } from 'react';
import './App.css';

const App = () => {
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const stats = [
    { label: 'Total Revenue', value: '$45,231', change: '+12.5%', positive: true },
    { label: 'Active Users', value: '2,345', change: '+8.2%', positive: true },
    { label: 'Orders', value: '1,234', change: '-2.4%', positive: false },
    { label: 'Conversion', value: '3.2%', change: '+1.2%', positive: true },
  ];

  const recentOrders = [
    { id: '#3210', customer: 'Olivia Martin', status: 'Completed', amount: '$256.00' },
    { id: '#3209', customer: 'Jackson Lee', status: 'Processing', amount: '$128.00' },
    { id: '#3208', customer: 'Isabella Nguyen', status: 'Pending', amount: '$512.00' },
    { id: '#3207', customer: 'William Chen', status: 'Completed', amount: '$96.00' },
  ];

  return (
    <div className="dashboard">
      {/* Sidebar */}
      <aside className={\`sidebar \${sidebarOpen ? 'open' : 'closed'}\`}>
        <div className="sidebar-header">
          <span className="logo">Dashboard</span>
        </div>
        <nav className="sidebar-nav">
          <a href="#" className="nav-item active">Overview</a>
          <a href="#" className="nav-item">Analytics</a>
          <a href="#" className="nav-item">Orders</a>
          <a href="#" className="nav-item">Products</a>
          <a href="#" className="nav-item">Customers</a>
          <a href="#" className="nav-item">Settings</a>
        </nav>
      </aside>

      {/* Main Content */}
      <main className="main-content">
        <header className="header">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className="menu-btn">
            ☰
          </button>
          <h1>Dashboard Overview</h1>
          <div className="header-actions">
            <button className="btn btn-primary">Export</button>
          </div>
        </header>

        {/* Stats Grid */}
        <section className="stats-grid">
          {stats.map((stat, i) => (
            <div key={i} className="stat-card">
              <span className="stat-label">{stat.label}</span>
              <span className="stat-value">{stat.value}</span>
              <span className={\`stat-change \${stat.positive ? 'positive' : 'negative'}\`}>
                {stat.change}
              </span>
            </div>
          ))}
        </section>

        {/* Recent Orders */}
        <section className="orders-section">
          <h2>Recent Orders</h2>
          <table className="orders-table">
            <thead>
              <tr>
                <th>Order ID</th>
                <th>Customer</th>
                <th>Status</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {recentOrders.map((order, i) => (
                <tr key={i}>
                  <td>{order.id}</td>
                  <td>{order.customer}</td>
                  <td><span className={\`status \${order.status.toLowerCase()}\`}>{order.status}</span></td>
                  <td>{order.amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </div>
  );
};

export default App;`;

const DASHBOARD_CSS = `/* Dashboard Styles */
:root {
  --primary: #6366f1;
  --sidebar-bg: #1f2937;
  --sidebar-width: 260px;
  --header-height: 64px;
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Inter', sans-serif; background: #f9fafb; }

.dashboard { display: flex; min-height: 100vh; }

/* Sidebar */
.sidebar {
  width: var(--sidebar-width);
  background: var(--sidebar-bg);
  color: white;
  transition: width 0.3s;
  position: fixed;
  height: 100vh;
}
.sidebar.closed { width: 0; overflow: hidden; }
.sidebar-header { padding: 1.5rem; border-bottom: 1px solid rgba(255,255,255,0.1); }
.logo { font-size: 1.25rem; font-weight: 700; }
.sidebar-nav { padding: 1rem 0; }
.nav-item {
  display: block;
  padding: 0.75rem 1.5rem;
  color: #9ca3af;
  text-decoration: none;
  transition: all 0.2s;
}
.nav-item:hover, .nav-item.active { background: rgba(255,255,255,0.1); color: white; }

/* Main Content */
.main-content {
  flex: 1;
  margin-left: var(--sidebar-width);
  transition: margin-left 0.3s;
}
.sidebar.closed + .main-content { margin-left: 0; }

/* Header */
.header {
  height: var(--header-height);
  background: white;
  border-bottom: 1px solid #e5e7eb;
  display: flex;
  align-items: center;
  padding: 0 2rem;
  gap: 1rem;
}
.menu-btn { background: none; border: none; font-size: 1.5rem; cursor: pointer; }
.header h1 { flex: 1; font-size: 1.25rem; }
.btn { padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; border: none; }
.btn-primary { background: var(--primary); color: white; }

/* Stats */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 1.5rem;
  padding: 2rem;
}
.stat-card {
  background: white;
  padding: 1.5rem;
  border-radius: 12px;
  box-shadow: 0 1px 3px rgba(0,0,0,0.1);
}
.stat-label { display: block; color: #6b7280; font-size: 0.9rem; }
.stat-value { display: block; font-size: 2rem; font-weight: 700; margin: 0.5rem 0; }
.stat-change { font-size: 0.85rem; }
.stat-change.positive { color: #10b981; }
.stat-change.negative { color: #ef4444; }

/* Orders */
.orders-section { padding: 0 2rem 2rem; }
.orders-section h2 { margin-bottom: 1rem; }
.orders-table { width: 100%; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
.orders-table th, .orders-table td { padding: 1rem; text-align: left; }
.orders-table th { background: #f9fafb; font-weight: 600; color: #6b7280; }
.orders-table tr:not(:last-child) td { border-bottom: 1px solid #e5e7eb; }
.status { padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.8rem; }
.status.completed { background: #d1fae5; color: #059669; }
.status.processing { background: #fef3c7; color: #d97706; }
.status.pending { background: #e5e7eb; color: #6b7280; }

@media (max-width: 768px) {
  .sidebar { position: absolute; z-index: 100; }
  .main-content { margin-left: 0; }
}`;

// ============================================================================
// EXPORT TEMPLATES
// ============================================================================

export const PREMIUM_TEMPLATES: ProjectTemplate[] = [
    {
        id: 'saas-landing',
        name: 'SaaS Landing Page',
        description: 'Modern landing page with hero, features, pricing, and footer sections.',
        category: 'landing',
        thumbnail: '/templates/saas-landing.png',
        tags: ['landing', 'saas', 'marketing', 'startup'],
        files: [
            { path: 'src/App.tsx', content: SAAS_LANDING_APP },
            { path: 'src/App.css', content: SAAS_LANDING_CSS },
        ],
    },
    {
        id: 'admin-dashboard',
        name: 'Admin Dashboard',
        description: 'Clean dashboard with sidebar navigation, stats cards, and data tables.',
        category: 'dashboard',
        thumbnail: '/templates/dashboard.png',
        tags: ['dashboard', 'admin', 'analytics', 'data'],
        files: [
            { path: 'src/App.tsx', content: DASHBOARD_APP },
            { path: 'src/App.css', content: DASHBOARD_CSS },
        ],
    },
];

export function getTemplateById(id: string): ProjectTemplate | undefined {
    return PREMIUM_TEMPLATES.find(t => t.id === id);
}

export function getTemplatesByCategory(category: string): ProjectTemplate[] {
    return PREMIUM_TEMPLATES.filter(t => t.category === category);
}

export default PREMIUM_TEMPLATES;
