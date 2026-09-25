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
import { useI18n } from "@/contexts/I18nContext";
import type { TranslationKey } from "../../../shared/i18n";

interface ActiveFilters {
  status?: string;
  urgency?: string;
  legalArea?: string;
  dateRange?: string;
  experience?: string;
  accepting?: string;
}

interface SearchFilter {
  id: string;
  name: string;
  query: string;
  filters: ActiveFilters;
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
    nameKey: "search.preset.urgentCases" as TranslationKey,
    icon: TrendingUp,
    filters: { urgency: "high", status: "open" },
  },
  {
    id: "pending-response",
    nameKey: "search.preset.pendingResponse" as TranslationKey,
    icon: Clock,
    filters: { status: "waiting_for_lawyer" },
  },
  {
    id: "this-week",
    nameKey: "search.preset.thisWeek" as TranslationKey,
    icon: Clock,
    filters: { dateRange: "week" },
  },
];

const FILTER_LABEL_KEYS: Record<keyof ActiveFilters, TranslationKey> = {
  status: "search.status",
  urgency: "search.urgency",
  legalArea: "search.legalArea",
  dateRange: "search.dateRange",
  experience: "search.experience",
  accepting: "search.availability",
};

const FILTER_VALUE_KEYS: Partial<Record<keyof ActiveFilters, Record<string, TranslationKey>>> = {
  status: {
    open: "search.status.open",
    in_progress: "search.status.inProgress",
    waiting_for_lawyer: "search.status.waitingForLawyer",
    closed: "search.status.closed",
  },
  urgency: {
    high: "search.urgency.high",
    medium: "search.urgency.medium",
    low: "search.urgency.low",
  },
  dateRange: {
    today: "search.dateRange.today",
    week: "search.dateRange.week",
    month: "search.dateRange.month",
    year: "search.dateRange.year",
  },
  experience: {
    "0-5": "search.experience.zeroToFive",
    "6-10": "search.experience.sixToTen",
    "11-20": "search.experience.elevenToTwenty",
    "20+": "search.experience.moreThanTwenty",
  },
  accepting: {
    Yes: "search.availability.accepting",
    Limited: "search.availability.limited",
    No: "search.availability.notAccepting",
  },
};

export default function SmartSearchFilters({
  onSearch,
  searchType = "cases",
  compact = false,
}: {
  onSearch?: (query: string, filters: any) => void;
  searchType?: "cases" | "lawyers" | "evidence";
  compact?: boolean;
}) {
  const { t, formatDate, formatNumber } = useI18n();
  const [searchQuery, setSearchQuery] = useState("");

  // Fetch saved searches from backend
  const { data: savedSearchesData = [], refetch: refetchSavedSearches } = trpc.savedSearches.list.useQuery({ searchType });

  // Create saved search mutation
  const createSavedSearchMutation = trpc.savedSearches.create.useMutation({
    onSuccess: () => {
      refetchSavedSearches();
      toast.success(t("search.savedSuccess"));
    },
    onError: (error) => {
      toast.error(t("search.saveFailed", { error: error.message }));
    },
  });

  // Delete saved search mutation
  const deleteSavedSearchMutation = trpc.savedSearches.delete.useMutation({
    onSuccess: () => {
      refetchSavedSearches();
      toast.success(t("search.deleted"));
    },
  });

  // Convert backend saved searches to frontend format
  const savedFilters: SearchFilter[] = savedSearchesData.map((search) => ({
    id: search.id,
    name: search.name ?? t("search.savedFallback"),
    query: search.query || "",
    filters: (search.filters ?? {}) as ActiveFilters,
  }));

  const [recentSearches, setRecentSearches] = useState<RecentSearch[]>([]);

  const [activeFilters, setActiveFilters] = useState<ActiveFilters>({});

  const activeFilterCount = Object.values(activeFilters).filter(Boolean).length;
  const searchLabelKey = searchType === "lawyers"
    ? "search.lawyers"
    : searchType === "evidence"
      ? "search.evidence"
      : "search.cases";
  const searchPlaceholderKey = searchType === "lawyers"
    ? "search.placeholder.lawyers"
    : searchType === "evidence"
      ? "search.placeholder.evidence"
      : "search.placeholder.cases";

  const filterValue = (key: keyof ActiveFilters, value: string) => {
    const valueKey = FILTER_VALUE_KEYS[key]?.[value];
    return valueKey ? t(valueKey) : value;
  };

  const handleSearch = () => {
    if (searchQuery.trim()) {
      const newSearch: RecentSearch = {
        id: Date.now().toString(),
        query: searchQuery,
        timestamp: new Date(),
      };
      setRecentSearches((prev) => [newSearch, ...prev.slice(0, 9)]);
      toast.success(t("search.searchingFor", { query: searchQuery }));
    } else if (activeFilterCount > 0) {
      toast.success(t("search.filtersApplied"));
    } else {
      toast.info(t("search.enterQueryOrFilter"));
      return;
    }

    onSearch?.(searchQuery, activeFilters);
  };

  const handleSaveFilter = () => {
    if (!searchQuery.trim() && activeFilterCount === 0) {
      toast.error(t("search.enterQueryOrFilter"));
      return;
    }

    const filterName = window.prompt(t("search.namePrompt"));
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
    toast.success(t("search.loadedFilter", { name: filter.name }));
  };

  const handleDeleteFilter = (filterId: string) => {
    deleteSavedSearchMutation.mutate({ id: filterId });
  };

  const handleApplyPreset = (preset: (typeof FILTER_PRESETS)[number]) => {
    setActiveFilters(preset.filters);
    onSearch?.(searchQuery, preset.filters);
    toast.success(t("search.appliedPreset", { name: t(preset.nameKey) }));
  };

  return (
    <div className="space-y-4">
      {/* Inline Filters (shown first per client feedback) */}
      <Card className={compact ? "border-0 bg-transparent shadow-none" : ""}>
        <CardContent className={compact ? "p-0 space-y-3" : "p-4 space-y-4"}>
          <details open={compact ? undefined : true}>
            <summary className="mb-3 cursor-pointer py-2 text-sm font-medium">
              <SlidersHorizontal className="mr-2 inline h-4 w-4" />
              {activeFilterCount > 0
                ? t("search.filtersWithCount", { count: formatNumber(activeFilterCount) })
                : t("search.filters")}
            </summary>
          <div className={`grid grid-cols-1 ${searchType === "lawyers" ? "md:grid-cols-3" : "md:grid-cols-4"} ${compact ? "gap-3" : "gap-4"}`}>
            {searchType === "cases" && <div>
              <label className="text-sm font-medium mb-1 block text-muted-foreground">{t("search.status")}</label>
              <Select
                value={activeFilters.status || "all"}
                onValueChange={(value: string) =>
                  setActiveFilters((prev) => {
                    const next = { ...prev, status: value === "all" ? undefined : value };
                    onSearch?.(searchQuery, next);
                    return next;
                  })
                }
              >
                <SelectTrigger aria-label={t("search.filter.caseStatus")}>
                  <SelectValue placeholder={t("search.status.all")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("search.status.all")}</SelectItem>
                  <SelectItem value="open">{t("search.status.open")}</SelectItem>
                  <SelectItem value="in_progress">{t("search.status.inProgress")}</SelectItem>
                  <SelectItem value="waiting_for_lawyer">{t("search.status.waitingForLawyer")}</SelectItem>
                  <SelectItem value="closed">{t("search.status.closed")}</SelectItem>
                </SelectContent>
              </Select>
            </div>}

            {searchType === "cases" && <div>
              <label className="text-sm font-medium mb-1 block text-muted-foreground">{t("search.urgency")}</label>
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
                <SelectTrigger aria-label={t("search.filter.urgency")}>
                  <SelectValue placeholder={t("search.urgency.all")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("search.urgency.all")}</SelectItem>
                  <SelectItem value="high">{t("search.urgency.high")}</SelectItem>
                  <SelectItem value="medium">{t("search.urgency.medium")}</SelectItem>
                  <SelectItem value="low">{t("search.urgency.low")}</SelectItem>
                </SelectContent>
              </Select>
            </div>}

            {searchType === "lawyers" && <div>
              <label className="text-sm font-medium mb-1 block text-muted-foreground">{t("search.experience")}</label>
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
                <SelectTrigger aria-label={t("search.filter.experience")}>
                  <SelectValue placeholder={t("search.experience.any")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("search.experience.any")}</SelectItem>
                  <SelectItem value="0-5">{t("search.experience.zeroToFive")}</SelectItem>
                  <SelectItem value="6-10">{t("search.experience.sixToTen")}</SelectItem>
                  <SelectItem value="11-20">{t("search.experience.elevenToTwenty")}</SelectItem>
                  <SelectItem value="20+">{t("search.experience.moreThanTwenty")}</SelectItem>
                </SelectContent>
              </Select>
            </div>}

            {searchType === "lawyers" && <div>
              <label className="text-sm font-medium mb-1 block text-muted-foreground">{t("search.availability")}</label>
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
                <SelectTrigger aria-label={t("search.filter.availability")}>
                  <SelectValue placeholder={t("search.availability.any")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("search.availability.any")}</SelectItem>
                  <SelectItem value="Yes">{t("search.availability.accepting")}</SelectItem>
                  <SelectItem value="Limited">{t("search.availability.limited")}</SelectItem>
                  <SelectItem value="No">{t("search.availability.notAccepting")}</SelectItem>
                </SelectContent>
              </Select>
            </div>}

            <div>
              <label className="text-sm font-medium mb-1 block text-muted-foreground">{t("search.legalArea")}</label>
              <Input
                aria-label={t("search.filter.legalArea")}
                value={activeFilters.legalArea || ""}
                placeholder={t("search.legalArea.any")}
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
              <label className="text-sm font-medium mb-1 block text-muted-foreground">{t("search.dateRange")}</label>
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
                <SelectTrigger aria-label={t("search.filter.dateRange")}>
                  <SelectValue placeholder={t("search.dateRange.all")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("search.dateRange.all")}</SelectItem>
                  <SelectItem value="today">{t("search.dateRange.today")}</SelectItem>
                  <SelectItem value="week">{t("search.dateRange.week")}</SelectItem>
                  <SelectItem value="month">{t("search.dateRange.month")}</SelectItem>
                  <SelectItem value="year">{t("search.dateRange.year")}</SelectItem>
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
                aria-label={t(searchLabelKey)}
                placeholder={t(searchPlaceholderKey)}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                className="pl-9 pr-10"
              />
            </div>

            <Button onClick={handleSearch} aria-label={t("search.action")}>
              <Search className="h-4 w-4" />
              <span className="hidden sm:inline">{t("search.action")}</span>
            </Button>
            <Button
              variant="outline"
              onClick={handleSaveFilter}
              disabled={createSavedSearchMutation.isLoading}
              aria-label={t("search.saveCurrent")}
            >
              <Save className="h-4 w-4" />
              <span className="hidden sm:inline">{t("search.save")}</span>
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Active Filters */}
      {activeFilterCount > 0 && (
        <div className="flex flex-wrap gap-2">
          {Object.entries(activeFilters).map(([rawKey, value]) => {
            if (!value) return null;
            const key = rawKey as keyof ActiveFilters;
            const label = t(FILTER_LABEL_KEYS[key]);
            return (
              <Badge key={key} variant="secondary" className="gap-1 px-2 py-1">
                {label}: {filterValue(key, value)}
                <button
                  type="button"
                  aria-label={t("search.clearFilter", { filter: label })}
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
            );
          })}
        </div>
      )}

      {!compact && searchType === "cases" && (
        <div>
          <h4 className="text-sm font-medium mb-2 text-white">{t("search.quickFilters")}</h4>
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
                  {t(preset.nameKey)}
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
              <h4 className="text-sm font-medium text-white">{t("search.savedSearches")}</h4>
              <Badge variant="outline">{formatNumber(savedFilters.length)}</Badge>
            </div>
            <div className="space-y-2">
              {savedFilters.map((filter) => {
                const count = Object.values(filter.filters).filter(Boolean).length;
                return (
                  <div
                    key={filter.id}
                    className="flex items-center justify-between gap-2 rounded-lg border p-2 transition-colors hover:bg-accent/50"
                  >
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => handleLoadFilter(filter)}>
                      <span className="block truncate text-sm font-medium text-white">{filter.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {filter.query ? <>{filter.query} · </> : null}
                        {t(count === 1 ? "search.filterCountOne" : "search.filterCountMany", {
                          count: formatNumber(count),
                        })}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label={t("search.deleteSaved", { name: filter.name })}
                      onClick={() => handleDeleteFilter(filter.id)}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent Searches */}
      {!compact && recentSearches.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h4 className="text-sm font-medium mb-3 text-white">{t("search.recentSearches")}</h4>
            <div className="space-y-2">
              {recentSearches.slice(0, 5).map((search) => (
                <button
                  type="button"
                  key={search.id}
                  className="flex w-full items-center justify-between rounded-lg p-2 text-left transition-colors hover:bg-accent/50"
                  onClick={() => {
                    setSearchQuery(search.query);
                    onSearch?.(search.query, activeFilters);
                  }}
                >
                  <span className="flex min-w-0 flex-1 items-center gap-3">
                    <Clock className="w-4 h-4 text-muted-foreground" />
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-white">{search.query}</span>
                      {search.resultCount !== undefined && (
                        <span className="block text-xs text-muted-foreground">
                          {t(search.resultCount === 1 ? "search.resultCountOne" : "search.resultCountMany", {
                            count: formatNumber(search.resultCount),
                          })}
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDate(search.timestamp)}
                  </span>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
