import { Zap, ShoppingCart, Palette, Globe, Shield, Rocket } from "lucide-react";

const features = [
  {
    icon: Zap,
    title: "Lightning Fast",
    description: "Build complete stores in minutes with AI-powered generation",
  },
  {
    icon: ShoppingCart,
    title: "Full eCommerce Suite",
    description: "Products, cart, checkout, and payments - all integrated",
  },
  {
    icon: Palette,
    title: "Beautiful by Default",
    description: "Professional designs that convert, customized for your brand",
  },
  {
    icon: Globe,
    title: "Hong Kong Ready",
    description: "Optimized for HK payment gateways and local market needs",
  },
  {
    icon: Shield,
    title: "Enterprise Security",
    description: "Bank-level security with PCI compliance out of the box",
  },
  {
    icon: Rocket,
    title: "Scale Instantly",
    description: "From startup to enterprise, grow without limits",
  },
];

export const Features = () => {
  return (
    <section className="py-24 relative">
      <div className="container mx-auto px-4">
        <div className="text-center mb-16">
          <h2 className="text-4xl md:text-5xl font-bold mb-4 bg-gradient-accent bg-clip-text text-transparent">
            Everything You Need to Succeed
          </h2>
          <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
            Built with Hong Kong developers in mind, powered by cutting-edge AI
          </p>
        </div>
        
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-8">
          {features.map((feature, index) => (
            <div
              key={index}
              className="group relative p-8 rounded-2xl bg-gradient-card backdrop-blur-sm border border-border hover:border-primary/50 transition-all duration-300 hover:shadow-glow"
              style={{ animationDelay: `${index * 100}ms` }}
            >
              <div className="mb-4 inline-flex p-3 rounded-xl bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors duration-300">
                <feature.icon className="h-6 w-6" />
              </div>
              
              <h3 className="text-xl font-semibold mb-3 text-foreground">
                {feature.title}
              </h3>
              
              <p className="text-muted-foreground leading-relaxed">
                {feature.description}
              </p>
              
              {/* Hover effect gradient */}
              <div className="absolute inset-0 rounded-2xl bg-gradient-accent opacity-0 group-hover:opacity-5 transition-opacity duration-300" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};
