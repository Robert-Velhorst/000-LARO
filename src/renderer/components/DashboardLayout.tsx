import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { APP_LOGO, APP_TITLE } from "@/const";
import { ConnectionStatus } from "./ConnectionStatus";
import { useIsMobile } from "@/hooks/useMobile";
import { Home, LogOut, PanelLeft, Briefcase, Settings, HelpCircle, Shield, BarChart3, ChevronDown, ChevronRight, Megaphone, FileSearch } from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import ChatWidget from "./ChatWidget";
import NotificationCenter from "./NotificationCenter";
import { LegalAdviceNotice } from "./LegalAdviceNotice";
import { LanguageSelector } from "./LanguageSelector";
import { useI18n } from "@/contexts/I18nContext";
import type { TranslationKey } from "../../../shared/i18n";

// Main navigation items (case-centric design)
const mainMenuItems = [
  { icon: Home, labelKey: "nav.home", path: "/" },
  { icon: Briefcase, labelKey: "nav.cases", path: "/cases" },
  { icon: FileSearch, labelKey: "nav.evidence", path: "/evidence" },
  { icon: Megaphone, labelKey: "nav.outreach", path: "/outreach" },
  { icon: HelpCircle, labelKey: "nav.help", path: "/help" },
] satisfies Array<{ icon: typeof Home; labelKey: TranslationKey; path: string }>;



// Admin sub-menu
const adminMenuItems = [
  { icon: Shield, labelKey: "nav.adminPanel", path: "/admin" },
  { icon: BarChart3, labelKey: "nav.analytics", path: "/admin-analytics" },
] satisfies Array<{ icon: typeof Shield; labelKey: TranslationKey; path: string }>;

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

// Collapsible section component for Settings and Admin
function CollapsibleSection({
  title,
  icon: Icon,
  items,
  location,
  setLocation,
  className = ""
}: {
  title: string;
  icon: any;
  items: Array<{ icon: any; label: string; path: string }>;
  location: string;
  setLocation: (path: string) => void;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const hasActiveChild = items.some(item => location === item.path);

  // Auto-expand if a child is active
  useEffect(() => {
    if (hasActiveChild) {
      setIsOpen(true);
    }
  }, [hasActiveChild]);

  return (
    <div className={className}>
      <SidebarMenuItem>
        <SidebarMenuButton
          onClick={() => setIsOpen(!isOpen)}
          tooltip={title}
          className="h-10 rounded-lg font-normal text-sidebar-foreground/75 transition-colors hover:bg-white/10 hover:text-white"
        >
          <Icon className="h-4 w-4 shrink-0" />
          <span className="flex w-full items-center justify-between">
            {title}
            {isOpen ? <ChevronDown className="h-3 w-3 opacity-70" /> : <ChevronRight className="h-3 w-3 opacity-70" />}
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>

      {isOpen && (
        <div className="ml-4 border-l border-border/50 pl-2 space-y-0.5">
          {items.map(item => {
            const isActive = location === item.path;
            return (
              <SidebarMenuItem key={item.path}>
                <SidebarMenuButton
                  isActive={isActive}
                  onClick={() => setLocation(item.path)}
                  tooltip={item.label}
                  className={`h-9 rounded-md text-sm font-normal transition-colors ${isActive
                    ? "bg-white/15 text-white"
                    : "text-sidebar-foreground/75 hover:bg-white/10 hover:text-white"
                    }`}
                >
                  <item.icon className="h-3.5 w-3.5 shrink-0" />
                  <span>{item.label}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>
        {children}
      </DashboardLayoutContent>
    </SidebarProvider>
  );
}

type DashboardLayoutContentProps = {
  children: React.ReactNode;
  setSidebarWidth: (width: number) => void;
};

function DashboardLayoutContent({
  children,
  setSidebarWidth,
}: DashboardLayoutContentProps) {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const localizedMainMenuItems = mainMenuItems.map((item) => ({ ...item, label: t(item.labelKey) }));
  const localizedAdminMenuItems = adminMenuItems.map((item) => ({ ...item, label: t(item.labelKey) }));
  const activeMenuItem = localizedMainMenuItems.find(item => item.path === location);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (isCollapsed) {
      setIsResizing(false);
    }
  }, [isCollapsed]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const newWidth = e.clientX - sidebarLeft;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        <Sidebar
          collapsible="icon"
          className="border-r border-sidebar-accent/25 bg-sidebar text-sidebar-foreground"
          disableTransition={isResizing}
        >
          <SidebarHeader className="h-16 flex flex-row items-center px-4 border-b border-sidebar-accent/10">
            <div className="flex items-center gap-3 transition-all w-full overflow-hidden">
              {isCollapsed ? (
                <div className="relative h-9 w-9 shrink-0 group mx-auto">
                  <img
                    src={APP_LOGO}
                    className="h-9 w-9 rounded-lg object-cover shadow-sm ring-1 ring-white/10"
                    alt={APP_TITLE}
                  />
                  <button
                    type="button"
                    onClick={toggleSidebar}
                    aria-label={t("nav.expandSidebar")}
                    className="absolute inset-0 flex items-center justify-center rounded-lg bg-sidebar-accent/80 opacity-0 transition-opacity group-hover:opacity-100 focus:outline-none"
                  >
                    <PanelLeft className="h-4 w-4 text-sidebar-foreground" />
                  </button>
                </div>
              ) : (
                <>
                  <div className="flex items-center gap-3 min-w-0">
                    <img
                      src={APP_LOGO}
                      className="h-9 w-9 shrink-0 rounded-lg object-cover shadow-md ring-1 ring-white/10"
                      alt={APP_TITLE}
                    />
                    <span className="truncate font-bold text-lg tracking-tight text-sidebar-foreground">
                      {APP_TITLE}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={toggleSidebar}
                    aria-label={t("nav.collapseSidebar")}
                    className="ml-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus:outline-none"
                  >
                    <PanelLeft className="h-4 w-4" />
                  </button>
                </>
              )}
            </div>
          </SidebarHeader>

          <SidebarContent className="gap-0">
            <SidebarMenu className="px-2 py-1">
              {/* Main menu items */}
              {localizedMainMenuItems.map(item => {
                const isActive = location === item.path;
                return (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton
                      isActive={isActive}
                      onClick={() => setLocation(item.path)}
                      tooltip={item.label}
                      className={`h-10 rounded-lg font-normal transition-colors ${isActive
                        ? "bg-white/15 text-white"
                        : "text-sidebar-foreground/75 hover:bg-white/10 hover:text-white"
                        }`}
                    >
                      <item.icon className="h-4 w-4 shrink-0" />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}

              {/* Admin section (collapsible, admin-only) */}
              {user?.role === "admin" && (
                <CollapsibleSection
                  title={t("nav.admin")}
                  icon={Shield}
                  items={localizedAdminMenuItems}
                  location={location}
                  setLocation={setLocation}
                  className="border-t border-border/50 mt-2 pt-2"
                />
              )}
            </SidebarMenu>
          </SidebarContent>

          <SidebarFooter className="p-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("nav.accountMenu")}
                  className="flex items-center gap-3 rounded-lg px-1 py-1 hover:bg-accent/50 transition-colors w-full text-left justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Avatar className="h-9 w-9 border shrink-0">
                    <AvatarFallback className="text-xs font-medium">
                      {user?.name?.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <div className="border-b border-border/60 p-2">
                  <LanguageSelector />
                </div>
                <DropdownMenuItem
                  onClick={() => setLocation("/settings")}
                  className="cursor-pointer"
                >
                  <Settings className="mr-2 h-4 w-4" />
                  <span>{t("nav.settings")}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={logout}
                  className="cursor-pointer text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>{t("nav.signOut")}</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
        </Sidebar>
        <div
          className={`absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/20 transition-colors ${isCollapsed ? "hidden" : ""}`}
          onMouseDown={() => {
            if (isCollapsed) return;
            setIsResizing(true);
          }}
          style={{ zIndex: 50 }}
        />
      </div>

      <SidebarInset>
        {isMobile && (
          <div className="flex border-b h-14 items-center justify-between bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:backdrop-blur sticky top-0 z-40">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="h-9 w-9 rounded-lg bg-background" />
              <div className="flex items-center gap-3">
                <div className="flex flex-col gap-1">
                  <span className="tracking-tight text-foreground">
                    {activeMenuItem?.label ?? APP_TITLE}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ConnectionStatus />
              <NotificationCenter />
            </div>
          </div>
        )}
        <main id="main-content" className="min-w-0 flex-1 bg-black p-3 sm:p-6 md:p-8">
          {children}
          <LegalAdviceNotice />
        </main>
        {location !== "/" && <ChatWidget />}
      </SidebarInset>
    </>
  );
}
