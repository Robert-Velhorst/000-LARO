/**
 * Case Search and Filter Component
 * 
 * Search cases by title/description and filter by status, legal area, urgency
 */

import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, Filter, X } from "lucide-react";

interface CaseSearchFilterProps {
  onSearchChange: (search: string) => void;
  onStatusFilter: (status: string | null) => void;
  onUrgencyFilter: (urgency: string | null) => void;
  selectedStatus: string | null;
  selectedUrgency: string | null;
}

export default function CaseSearchFilter({
  onSearchChange,
  onStatusFilter,
  onUrgencyFilter,
  selectedStatus,
  selectedUrgency,
}: CaseSearchFilterProps) {
  const [searchTerm, setSearchTerm] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const handleSearchChange = (value: string) => {
    setSearchTerm(value);
    onSearchChange(value);
  };

  const clearFilters = () => {
    setSearchTerm("");
    onSearchChange("");
    onStatusFilter(null);
    onUrgencyFilter(null);
  };

  const hasActiveFilters = searchTerm || selectedStatus || selectedUrgency;

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
      <CardContent className="pt-6 space-y-4">
        {/* Search Bar */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search cases by title or description..."
              value={searchTerm}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-10"
            />
          </div>
          <Button
            variant="outline"
            onClick={() => setShowFilters(!showFilters)}
            className={showFilters ? "bg-orange-500/10 border-orange-500/30" : ""}
          >
            <Filter className="w-4 h-4 mr-2" />
            Filters
          </Button>
          {hasActiveFilters && (
            <Button
              variant="ghost"
              onClick={clearFilters}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="w-4 h-4 mr-2" />
              Clear
            </Button>
          )}
        </div>

        {/* Filter Options */}
        {showFilters && (
          <div className="space-y-4 pt-4 border-t border-border/50">
            {/* Status Filter */}
            <div className="space-y-2">
              <p className="text-sm font-medium">Status</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={selectedStatus === null ? "default" : "outline"}
                  size="sm"
                  onClick={() => onStatusFilter(null)}
                  className="text-xs"
                >
                  All
                </Button>
                <Button
                  variant={selectedStatus === "draft" ? "default" : "outline"}
                  size="sm"
                  onClick={() => onStatusFilter("draft")}
                  className="text-xs border-gray-500/30 hover:bg-gray-500/10"
                >
                  <Badge variant="secondary" className="mr-1 h-4 px-1">•</Badge>
                  Draft
                </Button>
                <Button
                  variant={selectedStatus === "active" ? "default" : "outline"}
                  size="sm"
                  onClick={() => onStatusFilter("active")}
                  className="text-xs border-blue-500/30 hover:bg-blue-500/10"
                >
                  <Badge className="bg-blue-500 mr-1 h-4 px-1">•</Badge>
                  Active
                </Button>
                <Button
                  variant={selectedStatus === "pending_response" ? "default" : "outline"}
                  size="sm"
                  onClick={() => onStatusFilter("pending_response")}
                  className="text-xs border-yellow-500/30 hover:bg-yellow-500/10"
                >
                  <Badge className="bg-yellow-500 mr-1 h-4 px-1">•</Badge>
                  Pending Response
                </Button>
                <Button
                  variant={selectedStatus === "matched" ? "default" : "outline"}
                  size="sm"
                  onClick={() => onStatusFilter("matched")}
                  className="text-xs border-green-500/30 hover:bg-green-500/10"
                >
                  <Badge className="bg-green-500 mr-1 h-4 px-1">•</Badge>
                  Matched
                </Button>
                <Button
                  variant={selectedStatus === "closed" ? "default" : "outline"}
                  size="sm"
                  onClick={() => onStatusFilter("closed")}
                  className="text-xs border-gray-500/30 hover:bg-gray-500/10"
                >
                  <Badge variant="outline" className="mr-1 h-4 px-1">•</Badge>
                  Closed
                </Button>
              </div>
            </div>

            {/* Urgency Filter */}
            <div className="space-y-2">
              <p className="text-sm font-medium">Urgency</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={selectedUrgency === null ? "default" : "outline"}
                  size="sm"
                  onClick={() => onUrgencyFilter(null)}
                  className="text-xs"
                >
                  All
                </Button>
                <Button
                  variant={selectedUrgency === "low" ? "default" : "outline"}
                  size="sm"
                  onClick={() => onUrgencyFilter("low")}
                  className="text-xs border-green-500/30 hover:bg-green-500/10"
                >
                  Low
                </Button>
                <Button
                  variant={selectedUrgency === "medium" ? "default" : "outline"}
                  size="sm"
                  onClick={() => onUrgencyFilter("medium")}
                  className="text-xs border-yellow-500/30 hover:bg-yellow-500/10"
                >
                  Medium
                </Button>
                <Button
                  variant={selectedUrgency === "high" ? "default" : "outline"}
                  size="sm"
                  onClick={() => onUrgencyFilter("high")}
                  className="text-xs border-red-500/30 hover:bg-red-500/10"
                >
                  High
                </Button>
                <Button
                  variant={selectedUrgency === "urgent" ? "default" : "outline"}
                  size="sm"
                  onClick={() => onUrgencyFilter("urgent")}
                  className="text-xs border-red-500/30 hover:bg-red-500/10"
                >
                  Urgent
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Active Filters Display */}
        {hasActiveFilters && (
          <div className="flex flex-wrap gap-2 pt-2 border-t border-border/50">
            {searchTerm && (
              <Badge variant="secondary" className="text-xs">
                Search: "{searchTerm}"
              </Badge>
            )}
            {selectedStatus && (
              <Badge variant="secondary" className="text-xs">
                Status: {selectedStatus}
              </Badge>
            )}
            {selectedUrgency && (
              <Badge variant="secondary" className="text-xs">
                Urgency: {selectedUrgency}
              </Badge>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

