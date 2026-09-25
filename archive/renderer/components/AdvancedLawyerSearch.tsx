import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  MapPin,
  Briefcase,
  X,
  Filter,
  ArrowRight
} from "lucide-react";
import { useLocation } from "wouter";

const commonLegalAreas = [
  "Algemene praktijk",
  "Arbeidsrecht",
  "Burgerlijk recht",
  "Familierecht",
  "Huurrecht",
  "Ondernemingsrecht",
  "Strafrecht",
  "Bestuursrecht",
  "Belastingrecht",
  "Socialezekerheidsrecht"
];

const dutchCities = [
  "Amsterdam",
  "Rotterdam",
  "Den Haag",
  "Utrecht",
  "Eindhoven",
  "Groningen",
  "Tilburg",
  "Almere",
  "Breda",
  "Nijmegen"
];

export default function AdvancedLawyerSearch() {
  const [, setLocation] = useLocation();
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedCity, setSelectedCity] = useState<string>("");
  const [selectedLegalAreas, setSelectedLegalAreas] = useState<string[]>([]);
  const [minResponseRate, setMinResponseRate] = useState<number>(0);

  const { data: resultsData, isLoading, refetch } = trpc.lawyers.list.useQuery({
    page: 1,
    limit: 20,
    search: searchTerm || undefined,
    city: selectedCity || undefined,
    legalAreas: selectedLegalAreas.length > 0 ? selectedLegalAreas : undefined
  }, {
    enabled: false // Only fetch when user clicks search
  });

  const handleSearch = () => {
    refetch();
  };

  const handleReset = () => {
    setSearchTerm("");
    setSelectedCity("");
    setSelectedLegalAreas([]);
    setMinResponseRate(0);
  };

  const toggleLegalArea = (area: string) => {
    setSelectedLegalAreas(prev =>
      prev.includes(area)
        ? prev.filter(a => a !== area)
        : [...prev, area]
    );
  };

  const results = Array.isArray(resultsData) ? resultsData : [];

  const filteredResults = results.filter((lawyer: any) => {
    if (minResponseRate > 0 && (lawyer.responseRate || 0) < minResponseRate) {
      return false;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Search Filters */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Advanced Lawyer Search</CardTitle>
              <CardDescription>
                Search lawyer records stored in LARO
              </CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={handleReset}>
              <X className="h-4 w-4 mr-2" />
              Reset
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Name/Firm Search */}
          <div className="space-y-2">
            <Label htmlFor="search">Lawyer or Firm Name</Label>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="search"
                placeholder="Search by name or firm..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              />
            </div>
          </div>

          {/* City Filter */}
          <div className="space-y-2">
            <Label htmlFor="city">City</Label>
            <Select value={selectedCity} onValueChange={setSelectedCity}>
              <SelectTrigger id="city">
                <SelectValue placeholder="All cities" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">All cities</SelectItem>
                {dutchCities.map((city) => (
                  <SelectItem key={city} value={city}>
                    <div className="flex items-center gap-2">
                      <MapPin className="h-3 w-3" />
                      {city}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Legal Areas */}
          <div className="space-y-2">
            <Label>Practice Areas</Label>
            <div className="flex flex-wrap gap-2">
              {commonLegalAreas.map((area) => {
                const isSelected = selectedLegalAreas.includes(area);
                return (
                  <Badge
                    key={area}
                    variant={isSelected ? "default" : "outline"}
                    className="cursor-pointer hover:bg-accent"
                    onClick={() => toggleLegalArea(area)}
                  >
                    <Briefcase className="h-3 w-3 mr-1" />
                    {area}
                    {isSelected && <X className="h-3 w-3 ml-1" />}
                  </Badge>
                );
              })}
            </div>
          </div>

          {/* Response Rate Filter */}
          <div className="space-y-2">
            <Label htmlFor="responseRate">
              Minimum Response Rate: {minResponseRate}%
            </Label>
            <input
              id="responseRate"
              type="range"
              min="0"
              max="100"
              step="10"
              value={minResponseRate}
              onChange={(e) => setMinResponseRate(parseInt(e.target.value))}
              className="w-full"
            />
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>0%</span>
              <span>50%</span>
              <span>100%</span>
            </div>
          </div>

          {/* Search Button */}
          <Button 
            className="w-full" 
            size="lg"
            onClick={handleSearch}
            disabled={isLoading}
          >
            {isLoading ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2" />
                Searching...
              </>
            ) : (
              <>
                <Search className="h-4 w-4 mr-2" />
                Search Lawyers
              </>
            )}
          </Button>
        </CardContent>
      </Card>

      {/* Search Results */}
      {results.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Search Results</CardTitle>
            <CardDescription>
              Found {filteredResults.length} lawyer{filteredResults.length !== 1 ? 's' : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {filteredResults.map((lawyer: any) => (
                <div
                  key={lawyer.id}
                  className="flex items-center justify-between p-4 rounded-lg border border-border hover:bg-accent transition-all cursor-pointer"
                  onClick={() => setLocation(`/lawyers/${lawyer.id}`)}
                >
                  <div className="flex-1 min-w-0">
                    <h4 className="font-medium">{lawyer.name}</h4>
                    <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
                      {lawyer.firmName && (
                        <span className="flex items-center gap-1">
                          <Briefcase className="h-3 w-3" />
                          {lawyer.firmName}
                        </span>
                      )}
                      {lawyer.city && (
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {lawyer.city}
                        </span>
                      )}
                    </div>
                    {lawyer.legalAreas && lawyer.legalAreas.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {lawyer.legalAreas.slice(0, 3).map((area: string, i: number) => (
                          <Badge key={i} variant="secondary" className="text-xs">
                            {area}
                          </Badge>
                        ))}
                        {lawyer.legalAreas.length > 3 && (
                          <Badge variant="secondary" className="text-xs">
                            +{lawyer.legalAreas.length - 3} more
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                  <Button variant="ghost" size="sm">
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty State */}
      {!isLoading && results.length === 0 && searchTerm && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Filter className="h-12 w-12 text-muted-foreground mb-4" />
            <p className="text-muted-foreground">No lawyers found</p>
            <p className="text-sm text-muted-foreground mt-2">
              Try adjusting your search filters
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

