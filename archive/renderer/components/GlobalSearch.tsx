import { useState, useEffect } from "react";
import { Search, FileText, Briefcase, Scale, File, MessageSquare, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";

export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [, setLocation] = useLocation();

  // Open with Ctrl+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const { data: searchResults, isLoading } = trpc.search.global.useQuery(
    { query, limit: 20 },
    { enabled: query.length >= 2 }
  );

  const getIcon = (type: string) => {
    switch (type) {
      case "case":
        return <Briefcase className="h-4 w-4" />;
      case "lawyer":
        return <Scale className="h-4 w-4" />;
      case "evidence":
        return <FileText className="h-4 w-4" />;
      case "document":
        return <File className="h-4 w-4" />;
      case "communication":
        return <MessageSquare className="h-4 w-4" />;
      default:
        return <FileText className="h-4 w-4" />;
    }
  };

  const handleResultClick = (result: any) => {
    setOpen(false);
    setQuery("");
    
    // Navigate based on type
    switch (result.type) {
      case "case":
        setLocation(`/cases/${result.id}`);
        break;
      case "lawyer":
        setLocation(`/lawyers/${result.id}`);
        break;
      case "evidence":
        setLocation(`/cases/${result.metadata.caseId}?tab=evidence`);
        break;
      case "document":
        setLocation(`/cases/${result.metadata.caseId}?tab=documents`);
        break;
      case "communication":
        setLocation(`/cases/${result.metadata.caseId}?tab=communications`);
        break;
    }
  };

  return (
    <>
      <div className="relative w-full max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search... (Ctrl+K)"
          className="pl-9"
          onClick={() => setOpen(true)}
          data-search-input
          readOnly
        />
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Search</DialogTitle>
            <DialogDescription>
              Search across cases, lawyers, evidence, and more
            </DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Type to search..."
              className="pl-9"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>

          <div className="flex-1 overflow-y-auto">
            {isLoading && query.length >= 2 && (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            )}

            {!isLoading && query.length >= 2 && searchResults && searchResults.results.length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                <p>No results found for "{query}"</p>
              </div>
            )}

            {!isLoading && searchResults && searchResults.results.length > 0 && (
              <div className="space-y-2 py-4">
                {searchResults.results.map((result) => (
                  <button
                    key={`${result.type}-${result.id}`}
                    onClick={() => handleResultClick(result)}
                    className={cn(
                      "w-full text-left p-4 rounded-lg border border-border",
                      "hover:bg-muted/50 transition-colors",
                      "focus:outline-none focus:ring-2 focus:ring-primary"
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className="mt-1 text-muted-foreground">
                        {getIcon(result.type)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="font-medium truncate">{result.title}</span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground capitalize">
                            {result.type}
                          </span>
                        </div>
                        <p className="text-sm text-muted-foreground line-clamp-2">
                          {result.description}
                        </p>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {query.length < 2 && (
              <div className="text-center py-12 text-muted-foreground">
                <p>Type at least 2 characters to search</p>
              </div>
            )}
          </div>

          <div className="pt-4 border-t border-border text-xs text-muted-foreground">
            <p>
              Tip: Use <kbd className="px-2 py-1 bg-muted rounded">Ctrl+K</kbd> to open search from anywhere
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

