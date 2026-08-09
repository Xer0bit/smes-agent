import { useTranslation } from "react-i18next";
import { Newspaper, Share2, Users, LayoutDashboard, LogOut, Building2, Palette, Settings } from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { useLocation } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { useUserRole } from "@/hooks/useUserRole";
import logoDark from "@/assets/fgv-logo.png";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";

export function AdminSidebar() {
  const { t } = useTranslation();
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const location = useLocation();
  const { signOut, user } = useAuth();
  const { isSuperAdmin } = useUserRole();

  const navItems = [
    { title: t("admin.dashboard"), url: "/admin", icon: LayoutDashboard },
    { title: t("admin.brand"), url: "/admin/brand", icon: Palette },
    { title: t("admin.pressReleases"), url: "/admin/press", icon: Newspaper },
    { title: t("admin.socialMedia"), url: "/admin/social", icon: Share2 },
    { title: t("admin.leads"), url: "/admin/leads", icon: Users },
    { title: t("admin.settings"), url: "/admin/settings", icon: Settings },
  ];

  const allNavItems = [
    ...navItems,
    ...(isSuperAdmin ? [{ title: t("admin.clients"), url: "/admin/clients", icon: Building2 }] : []),
  ];

  const isActive = (path: string) =>
    path === "/admin"
      ? location.pathname === "/admin"
      : location.pathname.startsWith(path);

  return (
    <Sidebar collapsible="icon">
      <SidebarContent>
        <SidebarGroup>
          <div className="flex items-center gap-2 px-2 py-3">
            <img src={logoDark} alt="FT30" className="w-7 h-7 object-contain shrink-0" />
            {!collapsed && <span className="font-display font-bold text-sm text-sidebar-foreground">FT30 Media</span>}
          </div>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>{t("admin.menu")}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {allNavItems.map((item) => (
                <SidebarMenuItem key={item.url}>
                  <SidebarMenuButton asChild isActive={isActive(item.url)}>
                    <NavLink to={item.url} end={item.url === "/admin"} className="hover:bg-sidebar-accent/50" activeClassName="bg-sidebar-accent text-sidebar-primary font-medium">
                      <item.icon className="mr-2 h-4 w-4" />
                      {!collapsed && <span>{item.title}</span>}
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        {!collapsed && user && (
          <p className="text-xs text-sidebar-foreground/60 px-2 truncate font-body">{user.email}</p>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={signOut}
          className="w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"
        >
          <LogOut className="h-4 w-4 mr-2" />
          {!collapsed && t("admin.signOut")}
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
