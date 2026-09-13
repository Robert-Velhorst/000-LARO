import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Search,
  Save,
  Clock,
  X,
  TrendingUp,
  SlidersHorizontal,
} from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

interface SearchFilter {
  id: string;
  name: string;
  query: string;
  filters: {
    status?: string;
    urgency?: string;
    legalArea?: string;
    dateRange?: string;
  };
  savedAt: Date;
}

interface RecentSearch {
  id: string;
  query: string;
  timestamp: Date;
  resultCount?: number;
}

const FILTER_PRESETS = [
  {
    id: "urgent-cases",
    name: "Urgent Cases",
    icon: TrendingUp,
    filters: { urgency: "high", status: "open" },
  },
  {
    id: "pending-response",
    name: "Pending Response",
    icon: Clock,
    filters: { status: "waiting_for_lawyer" },
  },
  {
    id: "this-week",
    name: "This Week",
    icon: Clock,
    filters: { dateRange: "week" },
  },
];

export default function SmartSearchFilters({
  onSearch,
  searchType = "cases",
  compact = false,
}: {
  onSearch?: (query: string, filters: any) => void;
  searchType?: "cases" | "lawyers" | "evidence";
  compact?: boolean;
}) {
  const [searchQuery, setSearchQuery] = useState("");

  // Fetch saved searches from backend
  const { data: savedSearchesData = [], refetch: refetchSavedSearches } = trpc.savedSearches.list.useQuery({ searchType });

  // Create saved search mutation
  const createSavedSearchMutation = trpc.savedSearches.create.useMutation({
    onSuccess: () => {
      refetchSavedSearches();
      toast.success("Search filter saved successfully");
    },
    onError: (error) => {
      toast.error("Failed to save search: " + error.message);
    },
  });

  // Delete saved search mutation
  const deleteSavedSearchMutation = trpc.savedSearches.delete.useMutation({
    onSuccess: () => {
      refetchSavedSearches();
      toast.success("Search filter deleted");
    },
  });

  // Convert backend saved searches to frontend format
  const savedFilters: SearchFilter[] = savedSearchesData.map((search) => ({
    id: search.id,
    name: search.name ?? "Saved search",
    query: search.query || "",
    filters: (search.filters ?? {}) as SearchFilter["filters"],
    savedAt: search.createdAt || new Date(),
  }));

  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);

  const [activeFilters, setActiveFilters] = useState<{
    status?: string;
    urgency?: string;
    legalArea?: string;
    dateRange?: string;
    experience?: string;
    accepting?: string;
  }>({});

  const activeFilterCount = Object.values(activeFilters).filter(Boolean).length;

  const handleSearch = () => {
    if (searchQuery.trim()) {
      const newSearch: RecentSearch = {
        id: Date.now().toString(),
        query: searchQuery,
        timestamp: new Date(),
      };
      setRecentSearches((prev) => [newSearch, ...prev.slice(0, 9)]);
      toast.success(`Searching for: ${searchQuery}`);
    } else {
      toast.success("Filters applied");
    }

    onSearch?.(searchQuery, activeFilters);
  };

  const handleSaveFilter = () => {
    if (!searchQuery.trim() && activeFilterCount === 0) {
      toast.error("Enter a search query or choose a filter first");
      return;
    }

    const filterName = prompt("Enter a name for this search filter:");
    if (!filterName) return;

    createSavedSearchMutation.mutate({
      name: filterName,
      query: searchQuery,
      filters: activeFilters,
      searchType,
    });
  };

  const handleLoadFilter = (filter: SearchFilter) => {
    setSearchQuery(filter.query);
    setActiveFilters(filter.filters);
    onSearch?.(filter.query, filter.filters);
    toast.success(`Loaded filter: ${filter.name}`);
  };

  const handleDeleteFilter = (filterId: string) => {
    deleteSavedSearchMutation.mutate({ id: filterId });
  };

  const handleApplyPreset = (preset: (typeof FILTER_PRESETS)[0]) => {
    setActiveFilters(preset.filters);
    onSearch?.(searchQuery, preset.filters);
    toast.success(`Applied preset: ${preset.name}`);
  };

  const handleClearFilters = () => {
    setActiveFilters({});
    setSearchQuery("");
    onSearch?.("", {});
    toast.info("Filters cleared");
  };

  return (
    <div className="space-y-4">
      {/* Inline Filters (shown first per client feedback) */}
      <Card className={compact ? "border-0 bg-transparent shadow-none" : ""}>
        <CardContent className={compact ? "p-0 space-y-3" : "p-4 space-y-4"}>
          <details open={compact ? undefined : true}>
            <summary className="mb-3 cursor-pointer py-2 text-sm font-medium"><SlidersHorizontal className="mr-2 inline h-4 w-4" />Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}</summary>
          <div className={`grid grid-cols-1 ${searchType === "lawyers" ? "md:grid-cols-3" : "md:grid-cols-4"} ${compact ? "gap-3" : "gap-4"}`}>
            {searchType === "cases" && <div>
              <label className="text-sm font-medium mb-1 block text-muted-foreground">Status</label>
              <Select
                value={activeFilters.status || "all"}
                onValueChange={(value: any) =>
                  setActiveFilters((prev) => {
                    const next = { ...prev, status: value === "all" ? undefined : value };
                    onSearch?.(searchQuery, next);
                    return next;
                  })
                }
              >
                <SelectTrigger aria-label="Filter by case status">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="open">Open</SelectItem>
                  <SelectItem value="in_progress">In Progress</SelectItem>
                  <SelectItem value="waiting_for_lawyer">Waiting for Lawyer</SelectItem>
                  <SelectItem value="closed">Closed</SelectItem>
                </SelectContent>
              </Select>
            </div>}

            {searchType === "cases" && <div>
              <label className="text-sm font-medium mb-1 block text-muted-foreground">Urgency</label>
              <Select
                value={activeFilters.urgency || "all"}
                onValueChange={(value: string) =>
                  setActiveFilters((prev) => {
                    const next = { ...prev, urgency: value === "all" ? undefined : value };
                    onSearch?.(searchQuery, next);
                    return next;
                  })
                }
              >
                <SelectTrigger aria-label="Filter by urgency">
                  <SelectValue placeholder="All urgencies" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All urgencies</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>}

            {searchType === "lawyers" && <div>
              <label className="text-sm font-medium mb-1 block text-muted-foreground">Experience</label>
              <Select
                value={activeFilters.experience || "all"}
                onValueChange={(value: string) =>
                  setActiveFilters((prev) => {
                    const next = { ...prev, experience: value === "all" ? undefined : value };
                    onSearch?.(searchQuery, next);
                    return next;
                  })
                }
              >
                <SelectTrigger aria-label="Filter by lawyer experience">
                  <SelectValue placeholder="Any experience" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any experience</SelectItem>
                  <SelectItem value="0-5">0-5 years</SelectItem>
                  <SelectItem value="6-10">6-10 years</SelectItem>
                  <SelectItem value="11-20">11-20 years</SelectItem>
                  <SelectItem value="20+">More than 20 years</SelectItem>
                </SelectContent>
              </Select>
            </div>}

            {searchType === "lawyers" && <div>
              <label className="text-sm font-medium mb-1 block text-muted-foreground">Availability</label>
              <Select
                value={activeFilters.accepting || "all"}
                onValueChange={(value: string) =>
                  setActiveFilters((prev) => {
                    const next = { ...prev, accepting: value === "all" ? undefined : value };
                    onSearch?.(searchQuery, next);
                    return next;
                  })
                }
              >
                <SelectTrigger aria-label="Filter by lawyer availability">
                  <SelectValue placeholder="Any availability" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Any availability</SelectItem>
                  <SelectItem value="Yes">Accepting cases</SelectItem>
                  <SelectItem value="Limited">Limited capacity</SelectItem>
                  <SelectItem value="No">Not accepting cases</SelectItem>
                </SelectContent>
              </Select>
            </div>}

            <div>
              <label className="text-sm font-medium mb-1 block text-muted-foreground">Legal Area</label>
              <Input
                aria-label="Filter by legal area"
                value={activeFilters.legalArea || ""}
                placeholder="Any legal area"
                onChange={(event) =>
                  setActiveFilters((prev) => {
                    const value = event.target.value.trimStart();
                    const next = { ...prev, legalArea: value || undefined };
                    onSearch?.(searchQuery, next);
                    return next;
                  })
                }
              />
            </div>

            {searchType === "cases" && <div>
              <label className="text-sm font-medium mb-1 block text-muted-foreground">Date Range</label>
              <Select
                value={activeFilters.dateRange || "all"}
                onValueChange={(value: string) =>
                  setActiveFilters((prev) => {
                    const next = { ...prev, dateRange: value === "all" ? undefined : value };
                    onSearch?.(searchQuery, next);
                    return next;
                  })
                }
              >
                <SelectTrigger aria-label="Filter by date range">
                  <SelectValue placeholder="All time" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All time</SelectItem>
                  <SelectItem value="today">Today</SelectItem>
                  <SelectItem value="week">This Week</SelectItem>
                  <SelectItem value="month">This Month</SelectItem>
                  <SelectItem value="year">This Year</SelectItem>
                </SelectContent>
              </Select>
            </div>}
          </div>

          </details>
          {/* Search Bar */}
          <div className="flex gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                aria-label={searchType === "lawyers" ? "Search lawyers" : "Search cases"}
                placeholder={searchType === "lawyers" ? "Search lawyer name, email, address, or legal area..." : "Search cases using natural language or keywords..."}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                className="pl-9 pr-10"
              />
            </div>

            <Button onClick={handleSearch} aria-label="Search"><Search className="h-4 w-4" /><span className="hidden sm:inline">Search</span></Button>
            <Button
              variant="outline"
              onClick={handleSaveFilter}
              disabled={createSavedSearchMutation.isLoading}
              aria-label="Save current search"
            >
              <Save className="h-4 w-4" />
              <span className="hidden sm:inline">Save</span>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Active Filters */}
      {activeFilterCount > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(activeFilters).map(([key, value]) =>
            value ? (
              <Badge key={key} variant="secondary" className="gap-1 px-2 py-1">
                {key}: {value}
                <button
                  type="button"
                  aria-label={`Clear ${key} filter`}
                  className="inline-flex h-4 w-4 items-center justify-center rounded hover:bg-background/50"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setActiveFilters((prev) => {
                      const next = { ...prev, [key]: undefined };
                      onSearch?.(searchQuery, next);
                      return next;
                    });
                  }}
                >
                  <X className="w-3 h-3 cursor-pointer hover:text-destructive" />
                </button>
              </Badge>
            ) : null
          )}
        </div>
      )}

      {!compact && searchType === "cases" && (
        <div>
          <h4 className="text-sm font-medium mb-2 text-white">Quick Filters</h4>
          <div className="flex flex-wrap gap-2">
            {FILTER_PRESETS.map((preset) => {
              const Icon = preset.icon;
              return (
                <Button
                  key={preset.id}
                  variant="outline"
                  size="sm"
                  onClick={() => handleApplyPreset(preset)}
                >
                  <Icon className="w-3 h-3 mr-2" />
                  {preset.name}
                </Button>
              );
            })}
          </div>
        </div>
      )}

      {/* Saved Filters */}
      {!compact && savedFilters.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-medium text-white">Saved Searches</h4>
              <Badge variant="outline">{savedFilters.length}</Badge>
            </div>
            <div className="space-y-2">
              {savedFilters.map((filter) => (
                <div
                  key={filter.id}
                  className="flex items-center justify-between p-2 rounded-lg border hover:bg-accent/50 transition-colors"
                >
                  <div className="flex-1 cursor-pointer" onClick={() => handleLoadFilter(filter)}>
                    <p className="text-sm font-medium text-white">{filter.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {filter.query} • {Object.values(filter.filters).filter(Boolean).length} filters
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => handleDeleteFilter(filter.id)}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Searches */}
      {!compact && recentSearches.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h4 className="text-sm font-medium mb-3 text-white">Recent Searches</h4>
            <div className="space-y-2">
              {recentSearches.slice(0, 5).map((search) => (
                <div
                  key={search.id}
                  className="flex items-center justify-between p-2 rounded-lg hover:bg-accent/50 transition-colors cursor-pointer"
                  onClick={() => {
                    setSearchQuery(search.query);
                    onSearch?.(search.query, activeFilters);
                  }}
                >
                  <div className="flex items-center gap-3 flex-1">
                    <Clock className="w-4 h-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm text-white">{search.query}</p>
                      {search.resultCount !== undefined && (
                        <p className="text-xs text-muted-foreground">{search.resultCount} results</p>
                      )}
                    </div>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(search.timestamp).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

