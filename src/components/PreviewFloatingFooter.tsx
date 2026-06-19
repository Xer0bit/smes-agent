import { useSubscription } from "@/contexts/SubscriptionContext";

interface PreviewFloatingFooterProps {
  type: 'full' | 'small';
}

export const PreviewFloatingFooter = ({ type }: PreviewFloatingFooterProps) => {
  const { subscribed } = useSubscription();

  // Hide branding for organizations on any active paid plan
  if (subscribed) {
    return null;
  }

  const handleClick = () => {
    window.open('https://www.ecomgear.dev', '_blank', 'noopener,noreferrer');
  };

  if (type === 'full') {
    return (
      <div 
        onClick={handleClick}
        className="fixed bottom-0 left-0 right-0 bg-gradient-to-r from-primary/90 to-primary-foreground/90 backdrop-blur-sm text-primary-foreground py-3 px-4 cursor-pointer hover:from-primary hover:to-primary-foreground transition-all duration-300 z-50 border-t border-primary-foreground/20"
      >
        <div className="max-w-7xl mx-auto flex items-center justify-center text-center">
          <p className="text-sm md:text-base font-medium">
            eCG - AI-Driven Web & App Launch - Zero to One Without Borders. 
            <span className="ml-2 font-semibold underline decoration-2 underline-offset-2">
              Launch your vision now.
            </span>
          </p>
        </div>
      </div>
    );
  }

  // Small tag for Org Member (Free)
  return (
    <div 
      onClick={handleClick}
      className="fixed top-4 right-4 bg-primary/90 backdrop-blur-sm text-primary-foreground px-3 py-1.5 rounded-full cursor-pointer hover:bg-primary transition-all duration-300 z-50 shadow-lg border border-primary-foreground/20"
    >
      <p className="text-xs font-semibold">Geared by eCG</p>
    </div>
  );
};
