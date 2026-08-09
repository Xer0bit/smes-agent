import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";

export const CTA = () => {
  return (
    <section className="py-24 relative overflow-hidden">
      <div className="container mx-auto px-4 relative z-10">
        <div className="max-w-4xl mx-auto text-center bg-card rounded-3xl p-12 md:p-16 border border-border">
          <h2 className="text-4xl md:text-5xl font-bold mb-6">
            Ready to Transform Your
            <br />
            <span className="bg-gradient-primary bg-clip-text text-transparent">
              eCommerce Vision?
            </span>
          </h2>
          
          <p className="text-xl text-muted-foreground mb-10 max-w-2xl mx-auto">
            Join hundreds of Hong Kong developers already building the future of online retail
          </p>
          
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button 
              size="lg" 
              className="group bg-gradient-primary text-primary-foreground hover:shadow-glow transition-all duration-300 px-10 py-7 text-lg"
            >
              Get Started Now
              <ArrowRight className="ml-2 group-hover:translate-x-1 transition-transform" />
            </Button>
            
            <Button 
              size="lg" 
              variant="outline" 
              className="border-primary/50 text-foreground hover:bg-primary/10 hover:border-primary transition-all duration-300 px-10 py-7 text-lg"
            >
              Schedule a Demo
            </Button>
          </div>
          
          <p className="mt-8 text-sm text-muted-foreground">
            Free forever • No credit card required • Deploy in seconds
          </p>
        </div>
      </div>
    </section>
  );
};
