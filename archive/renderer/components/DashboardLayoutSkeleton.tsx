import { Skeleton } from "./ui/skeleton";

export function DashboardLayoutSkeleton() {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      {/* Sidebar Skeleton */}
      <div className="w-[280px] border-r border-sidebar-accent/25 bg-sidebar flex flex-col p-4 space-y-4">
        <div className="h-10 w-32 bg-sidebar-accent/50 rounded-md animate-pulse" />
        <div className="space-y-2 pt-8">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-8 w-full bg-sidebar-accent/30 rounded-md animate-pulse" />
          ))}
        </div>
      </div>
      
      {/* Main Content Skeleton */}
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        <header className="h-16 border-b border-border/50 flex items-center px-8 justify-between">
          <div className="h-6 w-48 bg-muted rounded animate-pulse" />
          <div className="flex items-center gap-4">
            <div className="h-8 w-8 rounded-full bg-muted animate-pulse" />
            <div className="h-8 w-8 rounded-full bg-muted animate-pulse" />
          </div>
        </header>
        <main className="flex-1 p-8 space-y-6 overflow-auto">
          <div className="h-10 w-64 bg-muted rounded animate-pulse" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-32 w-full bg-muted rounded-xl animate-pulse" />
            ))}
          </div>
          <div className="h-64 w-full bg-muted rounded-xl animate-pulse" />
        </main>
      </div>
    </div>
  );
}
