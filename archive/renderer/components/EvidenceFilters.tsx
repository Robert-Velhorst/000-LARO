import React, { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { X, Search, Filter } from "lucide-react";

interface FilterOptions {
  searchQuery: string;
  source: string | null;
  type: string | null;
  relevance: "all" | "relevant" | "irrelevant";
  dateRange: "week" | "month" | "quarter" | "year" | "all";
  tags: string[];
}

interface EvidenceFiltersProps {
  onFilterChange: (filters: FilterOptions) => void;
  availableTags?: string[];
}

export default function EvidenceFilters({
  onFilterChange,
  availableTags = [],
}: EvidenceFiltersProps) {
  const [filters, setFilters] = useState<FilterOptions>({
    searchQuery: "",
    source: null,
    type: null,
    relevance: "all",
    dateRange: "all",
    tags: [],
  });

  const [showAdvanced, setShowAdvanced] = useState(false);

  const sources = [
    { value: "gmail", label: "Gmail" },
    { value: "outlook", label: "Outlook" },
    { value: "slack", label: "Slack" },
    { value: "trello", label: "Trello" },
    { value: "google-drive", label: "Google Drive" },
    { value: "onedrive", label: "OneDrive" },
    { value: "telegram", label: "Telegram" },
    { value: "manual", label: "Manual Upload" },
  ];

  const types = [
    { value: "email", label: "Email" },
    { value: "document", label: "Document" },
    { value: "message", label: "Message" },
    { value: "file", label: "File" },
    { value: "task", label: "Task" },
    { value: "other", label: "Other" },
  ];

  const dateRanges = [
    { value: "week", label: "Last Week" },
    { value: "month", label: "Last Month" },
    { value: "quarter", label: "Last Quarter" },
    { value: "year", label: "Last Year" },
    { value: "all", label: "All Time" },
  ];

  const handleFilterChange = (newFilters: Partial<FilterOptions>) => {
    const updated = { ...filters, ...newFilters };
    setFilters(updated);
    onFilterChange(updated);
  };

  const handleAddTag = (tag: string) => {
    if (!filters.tags.includes(tag)) {
      handleFilterChange({
        tags: [...filters.tags, tag],
      });
    }
  };

  const handleRemoveTag = (tag: string) => {
    handleFilterChange({
      tags: filters.tags.filter((t) => t !== tag),
    });
  };

  const handleReset = () => {
    const resetFilters: FilterOptions = {
      searchQuery: "",
      source: null,
      type: null,
      relevance: "all",
      dateRange: "all",
      tags: [],
    };
    setFilters(resetFilters);
    onFilterChange(resetFilters);
  };

  const hasActiveFilters =
    filters.searchQuery ||
    filters.source ||
    filters.type ||
    filters.relevance !== "all" ||
    filters.dateRange !== "all" ||
    filters.tags.length > 0;

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Filter className="w-4 h-4" />
            Search & Filter
          </CardTitle>
          {hasActiveFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReset}
              className="text-xs"
            >
              Reset Filters
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Search Bar */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search evidence by name, content, or tags..."
            className="pl-10"
            value={filters.searchQuery}
            onChange={(e) =>
              handleFilterChange({ searchQuery: e.target.value })
            }
          />
        </div>

        {/* Quick Filters */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Source Filter */}
          <Select value={filters.source || ""} onValueChange={(value) =>
            handleFilterChange({ source: value || null })
          }>
            <SelectTrigger>
              <SelectValue placeholder="All Sources" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">All Sources</SelectItem>
              {sources.map((source) => (
                <SelectItem key={source.value} value={source.value}>
                  {source.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Type Filter */}
          <Select value={filters.type || ""} onValueChange={(value) =>
            handleFilterChange({ type: value || null })
          }>
            <SelectTrigger>
              <SelectValue placeholder="All Types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">All Types</SelectItem>
              {types.map((type) => (
                <SelectItem key={type.value} value={type.value}>
                  {type.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Relevance Filter */}
          <Select
            value={filters.relevance}
            onValueChange={(value) =>
              handleFilterChange({
                relevance: value as "all" | "relevant" | "irrelevant",
              })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="All Relevance" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Relevance</SelectItem>
              <SelectItem value="relevant">Relevant Only</SelectItem>
              <SelectItem value="irrelevant">Not Relevant</SelectItem>
            </SelectContent>
          </Select>

          {/* Date Range Filter */}
          <Select
            value={filters.dateRange}
            onValueChange={(value) =>
              handleFilterChange({
                dateRange: value as
                  | "week"
                  | "month"
                  | "quarter"
                  | "year"
                  | "all",
              })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="All Time" />
            </SelectTrigger>
            <SelectContent>
              {dateRanges.map((range) => (
                <SelectItem key={range.value} value={range.value}>
                  {range.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Advanced Filters Toggle */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="w-full justify-center"
        >
          {showAdvanced ? "Hide Advanced Filters" : "Show Advanced Filters"}
        </Button>

        {/* Advanced Filters */}
        {showAdvanced && (
          <div className="space-y-3 pt-3 border-t border-border/50">
            {/* Tag Filter */}
            {availableTags.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Tags</p>
                <div className="flex flex-wrap gap-2">
                  {availableTags.map((tag) => (
                    <Badge
                      key={tag}
                      variant={
                        filters.tags.includes(tag) ? "default" : "outline"
                      }
                      className="cursor-pointer"
                      onClick={() =>
                        filters.tags.includes(tag)
                          ? handleRemoveTag(tag)
                          : handleAddTag(tag)
                      }
                    >
                      {tag}
                      {filters.tags.includes(tag) && (
                        <X className="w-3 h-3 ml-1" />
                      )}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Selected Tags Display */}
            {filters.tags.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Selected Tags</p>
                <div className="flex flex-wrap gap-2">
                  {filters.tags.map((tag) => (
                    <Badge key={tag} variant="secondary">
                      {tag}
                      <button
                        onClick={() => handleRemoveTag(tag)}
                        className="ml-1 hover:text-destructive"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Active Filters Display */}
        {hasActiveFilters && (
          <div className="pt-3 border-t border-border/50">
            <p className="text-xs text-muted-foreground mb-2">Active Filters:</p>
            <div className="flex flex-wrap gap-2">
              {filters.searchQuery && (
                <Badge variant="secondary">
                  Search: "{filters.searchQuery}"
                </Badge>
              )}
              {filters.source && (
                <Badge variant="secondary">
                  Source: {sources.find((s) => s.value === filters.source)?.label}
                </Badge>
              )}
              {filters.type && (
                <Badge variant="secondary">
                  Type: {types.find((t) => t.value === filters.type)?.label}
                </Badge>
              )}
              {filters.relevance !== "all" && (
                <Badge variant="secondary">
                  Relevance: {filters.relevance}
                </Badge>
              )}
              {filters.dateRange !== "all" && (
                <Badge variant="secondary">
                  Date: {dateRanges.find((d) => d.value === filters.dateRange)?.label}
                </Badge>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
