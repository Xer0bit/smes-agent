import { 
  Facebook, 
  Instagram, 
  ShoppingBag, 
  Chrome, 
  Twitter,
  Linkedin,
  Mail,
  MessageSquare,
  type LucideIcon 
} from "lucide-react";

export const integrationIconMap: Record<string, LucideIcon> = {
  facebook: Facebook,
  instagram: Instagram,
  shopify: ShoppingBag,
  google: Chrome,
  twitter: Twitter,
  linkedin: Linkedin,
  email: Mail,
  chat: MessageSquare,
};

export const getIntegrationIcon = (integration: string): LucideIcon => {
  const normalizedKey = integration.toLowerCase();
  return integrationIconMap[normalizedKey] || MessageSquare;
};
