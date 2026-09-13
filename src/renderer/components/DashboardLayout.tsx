import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useLocation } from "wouter";
import { Briefcase, ChevronDown, FileSearch, HelpCircle, Home, LogOut, Megaphone, MessageSquare, PanelLeft, Settings, Shield, StickyNote } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { useI18n } from "@/contexts/I18nContext";
import { APP_LOGO, APP_TITLE } from "@/const";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { LanguageSelector } from "./LanguageSelector";
import { LegalAdviceNotice } from "./LegalAdviceNotice";
import { ConnectionStatus } from "./ConnectionStatus";
import NotificationCenter from "./NotificationCenter";
import ChatWidget, { useChatSession } from "./ChatWidget";
import type { TranslationKey } from "../../../shared/i18n";

const LayoutContext = createContext(false);
const mainItems = [
  { icon: Home, label: "nav.home", path: "/" },
  { icon: Briefcase, label: "nav.cases", path: "/cases" },
  { icon: FileSearch, label: "nav.evidence", path: "/evidence" },
  { icon: Megaphone, label: "nav.outreach", path: "/outreach" },
  { icon: StickyNote, label: "nav.notes", path: "/messages" },
] satisfies Array<{ icon: typeof Home; label: TranslationKey; path: string }>;
const secondaryItems = [
  { icon: Settings, label: "nav.settings", path: "/settings" },
  { icon: HelpCircle, label: "nav.help", path: "/help" },
] satisfies Array<{ icon: typeof Home; label: TranslationKey; path: string }>;

export function activeWorkspacePath(path: string) {
  if (path.startsWith("/lawyers") || path === "/analytics") return "/outreach";
  if (path === "/email") return "/messages";
  if (["/email-settings", "/email-preferences", "/privacy"].includes(path)) return "/settings";
  if (path === "/admin-analytics") return "/admin";
  return path;
}

const WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 224;
function readWidth() {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return value && Number.isFinite(value) ? Math.min(300, Math.max(200, value)) : DEFAULT_WIDTH;
  } catch { return DEFAULT_WIDTH; }
}

// Existing pages can also render independently without nesting the application shell.
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const inLayout = useContext(LayoutContext);
  return inLayout ? <>{children}</> : <DashboardShell>{children}</DashboardShell>;
}

function DashboardShell({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(readWidth);
  useEffect(() => {
    try { localStorage.setItem(WIDTH_KEY, String(width)); } catch { /* Storage is optional. */ }
  }, [width]);
  return <LayoutContext.Provider value={true}>
    <SidebarProvider style={{ "--sidebar-width": `${width}px`, "--sidebar-width-icon": "64px" } as CSSProperties}>
      <WorkspaceFrame width={width} setWidth={setWidth}>{children}</WorkspaceFrame>
    </SidebarProvider>
  </LayoutContext.Provider>;
}

function WorkspaceFrame({ children, width, setWidth }: { children: ReactNode; width: number; setWidth: (width: number) => void }) {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar, isMobile, setOpenMobile } = useSidebar();
  const collapsed = !isMobile && state === "collapsed";
  const [assistantOpen, setAssistantOpen] = useState(false);
  const chatSession = useChatSession();
  const [resizing, setResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const activePath = activeWorkspacePath(location);
  const title = [...mainItems, ...secondaryItems, { path: "/admin", label: "nav.admin" as const }].find(item => item.path === activePath)?.label;

  useEffect(() => {
    setOpenMobile(false);
    document.title = `${title ? t(title) : t("route.notFound")} | LARO`;
  }, [location, setOpenMobile, t, title]);
  useEffect(() => {
    const open = () => setAssistantOpen(true);
    window.addEventListener("laro:open-assistant", open);
    return () => window.removeEventListener("laro:open-assistant", open);
  }, []);
  useEffect(() => {
    if (!resizing) return;
    const move = (event: PointerEvent) => setWidth(Math.min(300, Math.max(200, event.clientX - (sidebarRef.current?.getBoundingClientRect().left ?? 0))));
    const stop = () => setResizing(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [resizing, setWidth]);

  const navigate = (path: string) => { setOpenMobile(false); setLocation(path); };
  const menuItem = (item: { icon: typeof Home; label: TranslationKey; path: string }) => <SidebarMenuItem key={item.path}>
    <SidebarMenuButton isActive={activePath === item.path} aria-current={activePath === item.path ? "page" : undefined}
      aria-label={t(item.label)} tooltip={t(item.label)} onClick={() => navigate(item.path)} className="workspace-nav-item h-11 gap-3 rounded-md px-3">
      <item.icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {!collapsed && <span>{t(item.label)}</span>}
    </SidebarMenuButton>
  </SidebarMenuItem>;

  return <>
    <div ref={sidebarRef} className="relative shrink-0">
      <Sidebar collapsible="icon" disableTransition={resizing} className="border-border bg-sidebar text-sidebar-foreground">
        <SidebarHeader className="h-16 flex-row items-center justify-between border-b border-border px-3">
          {!collapsed && <div className="flex min-w-0 items-center gap-2.5">
            <img src={APP_LOGO} alt="" className="h-8 w-8 shrink-0 rounded-md" />
            <span className="text-lg font-semibold">{APP_TITLE}</span>
          </div>}
          <Button variant="ghost" size="icon" onClick={toggleSidebar} title={t(collapsed ? "nav.expandSidebar" : "nav.collapseSidebar")}
            aria-label={t(collapsed ? "nav.expandSidebar" : "nav.collapseSidebar")} className="h-9 w-9 shrink-0">
            <PanelLeft className="h-4 w-4" />
          </Button>
        </SidebarHeader>
        <SidebarContent className="px-2 py-4">
          <nav aria-label={t("nav.main")}><SidebarMenu>{mainItems.map(menuItem)}</SidebarMenu></nav>
          {user?.role === "admin" && <nav aria-label={t("nav.admin")} className="mt-4 border-t border-border pt-4"><SidebarMenu>
            {menuItem({ icon: Shield, label: "nav.admin", path: "/admin" })}
          </SidebarMenu></nav>}
        </SidebarContent>
        <SidebarFooter className="gap-3 border-t border-border px-2 py-3">
          <nav aria-label={t("nav.preferences")}><SidebarMenu>{secondaryItems.map(menuItem)}</SidebarMenu></nav>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label={t("nav.accountMenu")} className="flex min-h-12 w-full min-w-0 items-center gap-3 rounded-md p-2 text-left hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
                <Avatar className="h-8 w-8 shrink-0"><AvatarFallback>{user?.name?.charAt(0).toUpperCase() || "?"}</AvatarFallback></Avatar>
                {!collapsed && <><span className="min-w-0 flex-1 truncate text-sm font-medium">{user?.name || t("nav.account")}</span><ChevronDown className="h-4 w-4 shrink-0" /></>}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <div className="border-b border-border p-2"><LanguageSelector /></div>
              <DropdownMenuItem onClick={() => navigate("/settings")}><Settings className="mr-2 h-4 w-4" />{t("nav.settings")}</DropdownMenuItem>
              <DropdownMenuItem onClick={logout} className="text-destructive focus:text-destructive"><LogOut className="mr-2 h-4 w-4" />{t("nav.signOut")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarFooter>
      </Sidebar>
      {!collapsed && !isMobile && <div role="separator" tabIndex={0} aria-label={t("nav.resizeSidebar")} aria-orientation="vertical" aria-valuemin={200} aria-valuemax={300} aria-valuenow={width}
        onPointerDown={(event) => { event.preventDefault(); setResizing(true); }}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          setWidth(event.key === "Home" ? 200 : event.key === "End" ? 300 : Math.min(300, Math.max(200, width + (event.key === "ArrowRight" ? 10 : -10))));
        }}
        className="absolute inset-y-0 right-0 z-40 w-1 cursor-col-resize hover:bg-primary/40 focus-visible:bg-primary focus-visible:outline-none" />}
    </div>
    <SidebarInset>
      <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2">
          {isMobile && <SidebarTrigger />}
          <span className="truncate text-sm font-medium text-muted-foreground">{title ? t(title) : APP_TITLE}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-3">
          <div className="hidden sm:block"><ConnectionStatus /></div>
          <Button variant="outline" onClick={() => setAssistantOpen(true)} aria-label={t("nav.openAssistant")} title={t("nav.openAssistant")}>
            <MessageSquare className="h-4 w-4" /><span className="hidden sm:inline">{t("nav.assistant")}</span>
          </Button>
          <NotificationCenter />
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className="workspace-main min-w-0 flex-1 p-4 outline-none sm:p-6 lg:px-8">
        <div className="mx-auto w-full min-w-0 max-w-[1440px]">{children}</div>
      </main>
      <footer className="mx-auto w-full max-w-[1504px] px-4 pb-4 sm:px-6 lg:px-8"><LegalAdviceNotice /></footer>
    </SidebarInset>
    <Dialog open={assistantOpen} onOpenChange={setAssistantOpen}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl overflow-y-auto p-0">
        <DialogHeader className="sr-only"><DialogTitle>{t("nav.assistant")}</DialogTitle><DialogDescription>{t("nav.assistantContext")}</DialogDescription></DialogHeader>
        <ChatWidget embedded session={chatSession} />
      </DialogContent>
    </Dialog>
  </>;
}
