import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { PanelLeft } from "lucide-react";

import { useIsMobile } from "@/hooks/useMobile";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type SidebarContextValue = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

function useSidebar() {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }
  return ctx;
}

function SidebarProvider({
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const isMobile = useIsMobile();
  const [open, setOpen] = React.useState(true);
  const [openMobile, setOpenMobile] = React.useState(false);

  const toggleSidebar = React.useCallback(() => {
    if (isMobile) setOpenMobile((o) => !o);
    else setOpen((o) => !o);
  }, [isMobile]);

  const state: "expanded" | "collapsed" = open ? "expanded" : "collapsed";

  const value = React.useMemo(
    () => ({
      state,
      open,
      setOpen,
      openMobile,
      setOpenMobile,
      isMobile,
      toggleSidebar,
    }),
    [state, open, openMobile, isMobile, toggleSidebar]
  );

  return (
    <SidebarContext.Provider value={value}>
      <TooltipProvider delayDuration={0}>
        <div
          data-slot="sidebar-wrapper"
          className={cn(
            "group/sidebar-wrapper flex min-h-svh w-full",
            className
          )}
          style={
            {
              "--sidebar-width": "16rem",
              "--sidebar-width-icon": "3rem",
              ...style,
            } as React.CSSProperties
          }
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  );
}

const sidebarMenuButtonVariants = cva(
  "peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none transition-[width,height,padding] focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "hover:bg-white/10",
        outline: "bg-background shadow-[0_0_0_1px_hsl(var(--border))] hover:bg-white/10",
      },
      size: {
        default: "h-8 text-sm",
        sm: "h-7 text-xs",
        lg: "h-12 text-sm",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  ...props
}: React.ComponentProps<"button"> & {
  asChild?: boolean;
  isActive?: boolean;
  tooltip?: string | React.ComponentProps<typeof TooltipContent>;
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const Comp = asChild ? Slot : "button";
  const { isMobile, state } = useSidebar();

  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      className={cn(
        sidebarMenuButtonVariants({ variant, size }),
        isActive && "bg-white/15 font-medium",
        "group-data-[collapsible=icon]/sidebar:w-8! group-data-[collapsible=icon]/sidebar:justify-center group-data-[collapsible=icon]/sidebar:p-2!",
        className
      )}
      {...props}
    />
  );

  if (!tooltip) {
    return button;
  }

  let tooltipProps: React.ComponentProps<typeof TooltipContent> =
    typeof tooltip === "string" ? { children: tooltip } : tooltip;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent
        side="right"
        align="center"
        hidden={state !== "collapsed" || isMobile}
        {...tooltipProps}
      />
    </Tooltip>
  );
}

function Sidebar({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  disableTransition = false,
  className,
  children,
  ...props
}: React.ComponentProps<"aside"> & {
  side?: "left" | "right";
  variant?: "sidebar" | "floating" | "inset";
  collapsible?: "offcanvas" | "icon" | "none";
  disableTransition?: boolean;
}) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();
  const mobileSidebarRef = React.useRef<HTMLElement>(null);
  const restoreFocusRef = React.useRef<HTMLElement | null>(null);

  React.useLayoutEffect(() => {
    const sidebar = mobileSidebarRef.current;
    if (!sidebar) return;
    sidebar.inert = !openMobile;
    if (!isMobile || !openMobile) return;

    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    const focusableSelector = [
      "a[href]",
      "button:not([disabled])",
      "input:not([disabled])",
      "select:not([disabled])",
      "textarea:not([disabled])",
      "[tabindex]:not([tabindex='-1'])",
    ].join(",");
    const getFocusable = () => Array.from(
      sidebar.querySelectorAll<HTMLElement>(focusableSelector),
    ).filter((element) => !element.hasAttribute("hidden") && element.getClientRects().length > 0);

    sidebar.querySelector<HTMLElement>(focusableSelector)?.focus({ preventScroll: true });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpenMobile(false);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        sidebar.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      const restoreTarget = restoreFocusRef.current;
      if (restoreTarget?.isConnected) {
        restoreTarget.focus();
      }
    };
  }, [isMobile, openMobile, setOpenMobile]);

  if (collapsible === "none") {
    return (
      <aside
        data-slot="sidebar"
        className={cn("flex h-svh flex-col border-r", className)}
        {...props}
      >
        {children}
      </aside>
    );
  }

  const widthClass =
    state === "collapsed" && collapsible === "icon"
      ? "w-[var(--sidebar-width-icon)]"
      : "w-[var(--sidebar-width)]";

  const transitionClass = disableTransition ? "" : "transition-[width] duration-200 ease-linear";

  if (isMobile) {
    return (
      <>
        {openMobile ? (
          <button
            type="button"
            aria-label="Close menu"
            aria-hidden="true"
            tabIndex={-1}
            className="fixed inset-0 z-40 bg-black/50 md:hidden"
            onClick={() => setOpenMobile(false)}
          />
        ) : null}
        <aside
          ref={mobileSidebarRef}
          id="laro-mobile-sidebar"
          data-slot="sidebar"
          data-state={openMobile ? "expanded" : "collapsed"}
          data-collapsible={collapsible}
          data-variant={variant}
          data-side={side}
          aria-hidden={!openMobile}
          tabIndex={-1}
          className={cn(
            "fixed inset-y-0 z-50 flex h-svh flex-col border-r border-sidebar-accent/25 bg-sidebar text-sidebar-foreground md:hidden",
            side === "left" ? "left-0" : "right-0",
            "w-[min(100vw,var(--sidebar-width))]",
            transitionClass,
            openMobile
              ? "visible translate-x-0"
              : side === "left"
                ? "invisible -translate-x-full pointer-events-none"
                : "invisible translate-x-full pointer-events-none",
            className
          )}
          {...props}
        >
          {children}
        </aside>
      </>
    );
  }

  return (
    <aside
      data-slot="sidebar"
      data-state={state}
      data-collapsible={collapsible}
      data-variant={variant}
      data-side={side}
      className={cn(
        "group/sidebar sticky top-0 z-30 hidden h-svh shrink-0 flex-col border-r border-sidebar-accent/25 md:flex",
        widthClass,
        transitionClass,
        variant === "floating" && "m-2 rounded-lg border shadow-sm",
        className
      )}
      {...props}
    >
      {children}
    </aside>
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-header"
      data-sidebar="header"
      className={cn("flex flex-col gap-2 p-2", className)}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-footer"
      data-sidebar="footer"
      className={cn("mt-auto flex flex-col gap-2 p-2", className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]/sidebar:overflow-hidden",
        className
      )}
      {...props}
    />
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-inset"
      className={cn(
        "relative flex min-h-svh min-w-0 flex-1 flex-col bg-background",
        className
      )}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn("flex w-full min-w-0 flex-col gap-1", className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    />
  );
}

function SidebarTrigger({
  className,
  onClick,
  onKeyUp,
  ...props
}: React.ComponentProps<typeof Button>) {
  const { toggleSidebar, isMobile, openMobile } = useSidebar();
  const focusMobileSidebar = React.useCallback(() => {
    const sidebar = document.getElementById("laro-mobile-sidebar");
    if (sidebar?.getAttribute("aria-hidden") === "false") {
      sidebar.querySelector<HTMLElement>("button:not([disabled])")?.focus({ preventScroll: true });
    }
  }, []);
  return (
    <Button
      data-sidebar="trigger"
      aria-controls={isMobile ? "laro-mobile-sidebar" : undefined}
      aria-expanded={isMobile ? openMobile : undefined}
      variant="ghost"
      size="icon"
      className={cn("h-9 w-9", className)}
      onClick={(e) => {
        const openingMobileSidebar = isMobile && !openMobile;
        toggleSidebar();
        if (openingMobileSidebar) {
          window.setTimeout(focusMobileSidebar, 50);
        }
        onClick?.(e);
      }}
      onKeyUp={(event) => {
        if (isMobile && openMobile && (event.key === "Enter" || event.key === " ")) {
          focusMobileSidebar();
        }
        onKeyUp?.(event);
      }}
      {...props}
    >
      <PanelLeft className="h-4 w-4" />
      <span className="sr-only">Toggle sidebar</span>
    </Button>
  );
}

export {
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
};
