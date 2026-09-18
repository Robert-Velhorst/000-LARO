import { trpc } from "@/lib/trpc";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Mail, Phone, Globe, MapPin, Users, GitCompare, ExternalLink, Database, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";
import LawyerComparisonView from "@/components/LawyerComparison";
import SmartSearchFilters from "@/components/SmartSearchFilters";
import { useLocation } from "wouter";
import { CasePicker } from "@/components/WorkspaceUi";

export function LawyersDirectoryContent({ embedded = false }: { embedded?: boolean }) {
  const [, setLocation] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [filterLegalArea, setFilterLegalArea] = useState("");
  const [filterExperience, setFilterExperience] = useState("");
  const [filterAccepting, setFilterAccepting] = useState("");
  const [officialOnly, setOfficialOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [comparisonMode, setComparisonMode] = useState(false);
  const [selectedLawyerIds, setSelectedLawyerIds] = useState<string[]>([]);
  const [comparisonCaseId, setComparisonCaseId] = useState<string | null>(null);
  const pageSize = 24;

  const { data, isLoading, isFetching, error } = trpc.lawyers.list.useQuery({
    page,
    limit: pageSize,
    query: searchQuery.trim() || undefined,
    legalArea: filterLegalArea.trim() || undefined,
    experience: filterExperience
      ? filterExperience as "0-5" | "6-10" | "11-20" | "20+"
      : undefined,
    accepting: filterAccepting
      ? filterAccepting as "Yes" | "Limited" | "No" | "Unknown"
      : undefined,
    officialOnly,
  });

  const parseStringArray = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value !== "string") return [];
    const trimmed = value.trim();
    if (!trimmed) return [];

    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
      if (typeof parsed === "string" && parsed.trim()) return [parsed.trim()];
    } catch {
      // Fallback for legacy/non-JSON values like "Verzekeringsrecht"
      return trimmed
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    return [];
  };

  const toggleLawyerSelection = (lawyerId: string) => {
    if (selectedLawyerIds.includes(lawyerId)) {
      setSelectedLawyerIds(selectedLawyerIds.filter(id => id !== lawyerId));
    } else if (selectedLawyerIds.length < 3) {
      setSelectedLawyerIds([...selectedLawyerIds, lawyerId]);
    }
  };

  const lawyers = data?.lawyers || [];
  const pagination = data?.pagination || { total: 0, totalPages: 0, page, limit: pageSize };
  const firstResult = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1;
  const lastResult = Math.min(pagination.page * pagination.limit, pagination.total);

  return (
      <div className="min-w-0 space-y-6">
        {/* Header */}
        <div>
          {embedded ? (
            <h2 className="text-xl font-semibold">Lawyers Database</h2>
          ) : (
            <h1 className="text-2xl font-semibold">
              Lawyers Database
            </h1>
          )}
        </div>

        {/* Search and Filter */}
        <div className="space-y-4">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
            <div className="min-w-0 flex-1">
              <SmartSearchFilters
                compact
                searchType="lawyers"
                onSearch={(query, filters) => {
                  setSearchQuery(query);
                  if (filters) {
                    setFilterLegalArea(filters.legalArea || "");
                    setFilterExperience(filters.experience || "");
                    setFilterAccepting(filters.accepting || "");
                  }
                  setPage(1);
                }}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex min-h-10 items-center gap-2 rounded-md border border-border/60 px-3 text-sm">
                <Checkbox
                  aria-label="Official NOvA only"
                  checked={officialOnly}
                  onCheckedChange={(checked) => {
                    setOfficialOnly(checked === true);
                    setPage(1);
                  }}
                />
                Official NOvA only
              </label>
              <Button
                variant={comparisonMode ? "default" : "outline"}
                className={comparisonMode ? "bg-purple-600 hover:bg-purple-700" : "border-purple-500/30 hover:bg-purple-500/10 hover:border-purple-500/50"}
                onClick={() => {
                  const next = !comparisonMode;
                  setComparisonMode(next);
                  if (!next) {
                    setSelectedLawyerIds([]);
                    setComparisonCaseId(null);
                  }
                }}
              >
                <GitCompare className="w-4 h-4 mr-2" />
                {comparisonMode ? `Compare (${selectedLawyerIds.length}/3)` : "Compare Mode"}
              </Button>
              {comparisonMode && <CasePicker value={comparisonCaseId} onChange={setComparisonCaseId} emptyLabel="No case selected" />}
            </div>
          </div>

          {/* Results Count */}
          <div className="flex min-h-5 items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
            <span>
              Showing {firstResult}-{lastResult} of {pagination.total} lawyers
              {(data?.officialRecordCount || 0) > 0 && `; ${data?.officialRecordCount} linked to an official NOvA profile`}
            </span>
            {isFetching && !isLoading && <Loader2 className="h-4 w-4 animate-spin" aria-label="Updating lawyer results" />}
          </div>
        </div>

        {/* Comparison View */}
        {comparisonMode && selectedLawyerIds.length >= 2 && (
          <LawyerComparisonView lawyerIds={selectedLawyerIds} caseId={comparisonCaseId} onClose={() => {
            setComparisonMode(false);
            setSelectedLawyerIds([]);
            setComparisonCaseId(null);
          }} />
        )}

        {/* Lawyers Grid */}
        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive" role="alert">
            Lawyer records could not be loaded: {error.message}
          </div>
        ) : isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <Skeleton key={i} className="h-96 w-full bg-card/50" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {lawyers.map((lawyer: any) => {
              const legalAreas = parseStringArray(lawyer.legalAreas);
              const languages = parseStringArray(lawyer.languages);
              
              return (
                <Card 
                  key={lawyer.id} 
                  className={`border-border/50 bg-card/50 backdrop-blur-sm hover:bg-card/80 transition-all duration-300 hover:scale-105 hover:shadow-xl hover:shadow-purple-500/10 group ${
                    comparisonMode && selectedLawyerIds.includes(lawyer.id)
                      ? 'ring-2 ring-purple-500' 
                      : ''
                  }`}
                  onClick={() => comparisonMode && toggleLawyerSelection(lawyer.id)}
                  style={{ cursor: comparisonMode ? 'pointer' : 'default' }}
                >
                  <CardHeader>
                    <div className="flex items-start gap-4">
                      <div className="w-14 h-14 rounded-full bg-gradient-to-br from-purple-500 to-purple-700 flex items-center justify-center shrink-0 shadow-lg shadow-purple-500/20">
                        <span className="text-white font-semibold text-lg">
                          {lawyer.name?.split(' ').map((n: string) => n[0]).join('').slice(0, 2)}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <CardTitle className="text-lg truncate">{lawyer.name}</CardTitle>
                        {lawyer.experienceYears && Number(lawyer.experienceYears) > 0 && (
                          <p className="text-sm text-purple-400">
                            {lawyer.experienceYears} years experience
                          </p>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* Contact Info */}
                    <div className="space-y-2">
                      {lawyer.email && (
                        <div className="flex items-center gap-2 text-sm p-2 rounded-lg bg-background/30">
                          <Mail className="w-4 h-4 text-blue-500 shrink-0" />
                          <span className="text-muted-foreground truncate text-xs">{lawyer.email}</span>
                        </div>
                      )}
                      {lawyer.phone && (
                        <div className="flex items-center gap-2 text-sm p-2 rounded-lg bg-background/30">
                          <Phone className="w-4 h-4 text-green-500 shrink-0" />
                          <span className="text-muted-foreground text-xs">{lawyer.phone}</span>
                        </div>
                      )}
                      {lawyer.address && (
                        <div className="flex items-center gap-2 text-sm p-2 rounded-lg bg-background/30">
                          <MapPin className="w-4 h-4 text-purple-500 shrink-0" />
                          <span className="text-muted-foreground text-xs line-clamp-1">{lawyer.address}</span>
                        </div>
                      )}
                      {lawyer.website && (
                        <div className="flex items-center gap-2 text-sm p-2 rounded-lg bg-background/30">
                          <Globe className="w-4 h-4 text-orange-500 shrink-0" />
                          <a 
                            href={lawyer.website} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="text-primary hover:underline truncate text-xs"
                          >
                            Website
                          </a>
                        </div>
                      )}
                      {lawyer.officialProfileUrl && (
                        <div className="flex items-center gap-2 text-sm p-2 rounded-lg bg-background/30">
                          <Database className="w-4 h-4 text-emerald-500 shrink-0" />
                          <a
                            href={lawyer.officialProfileUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-emerald-400 hover:underline truncate text-xs"
                          >
                            Official NOvA profile <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      )}
                    </div>

                    {/* Legal Areas */}
                    <div className="p-3 rounded-lg bg-background/50 border border-border/50">
                      <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1">
                        <Users className="w-3 h-3" />
                        Legal Areas
                      </p>
                      <div className="flex flex-wrap gap-1">
                        {legalAreas.slice(0, 3).map((area: string, idx: number) => (
                          <Badge key={idx} variant="secondary" className="text-xs bg-purple-500/10 text-purple-400 border-purple-500/20">
                            {area}
                          </Badge>
                        ))}
                        {legalAreas.length > 3 && (
                          <Badge variant="outline" className="text-xs border-purple-500/30 text-purple-400">
                            +{legalAreas.length - 3} more
                          </Badge>
                        )}
                      </div>
                    </div>

                    {/* Languages */}
                    <div className="p-3 rounded-lg bg-background/50 border border-border/50">
                      <p className="text-xs font-semibold text-muted-foreground mb-2">Languages</p>
                      <div className="flex flex-wrap gap-1">
                        {languages.map((lang: string, idx: number) => (
                          <Badge key={idx} variant="outline" className="text-xs border-blue-500/30 text-blue-400">
                            {lang}
                          </Badge>
                        ))}
                      </div>
                    </div>

                    {comparisonMode ? (
                      <Button 
                        variant={selectedLawyerIds.includes(lawyer.id) ? "default" : "outline"}
                        className={`w-full mt-4 transition-all ${
                          selectedLawyerIds.includes(lawyer.id)
                            ? 'bg-purple-600 hover:bg-purple-700'
                            : 'border-purple-500/30 hover:bg-purple-500/10 hover:border-purple-500/50'
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleLawyerSelection(lawyer.id);
                        }}
                        disabled={!selectedLawyerIds.includes(lawyer.id) && selectedLawyerIds.length >= 3}
                      >
                        {selectedLawyerIds.includes(lawyer.id) ? 'Selected' : 'Select to Compare'}
                      </Button>
                    ) : (
                      <Button 
                        variant="outline" 
                        className="w-full mt-4 border-purple-500/30 hover:bg-purple-500/10 hover:border-purple-500/50 transition-all group-hover:border-purple-500/50"
                        onClick={() => setLocation(`/lawyers/${lawyer.id}`)}
                      >
                        View Profile
                      </Button>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {!error && !isLoading && lawyers.length === 0 && (
          <div className="text-center py-12">
            <div className="w-16 h-16 rounded-full bg-purple-500/10 flex items-center justify-center mx-auto mb-4">
              <Search className="w-8 h-8 text-purple-500" />
            </div>
            <p className="text-muted-foreground">No lawyers found matching your search.</p>
          </div>
        )}

        {!error && pagination.totalPages > 1 && (
          <nav className="flex items-center justify-center gap-3" aria-label="Lawyer result pages">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1 || isFetching}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeft className="mr-1 h-4 w-4" />
              Previous
            </Button>
            <span className="min-w-28 text-center text-sm text-muted-foreground">
              Page {pagination.page} of {pagination.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= pagination.totalPages || isFetching}
              onClick={() => setPage((current) => Math.min(pagination.totalPages, current + 1))}
            >
              Next
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </nav>
        )}
      </div>
  );
}

export default function Lawyers() {
  return (
    <DashboardLayout>
      <LawyersDirectoryContent />
    </DashboardLayout>
  );
}
