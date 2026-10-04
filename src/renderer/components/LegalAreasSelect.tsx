import React, { useMemo, useState } from 'react';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

// Official 36 Dutch legal areas
const DUTCH_LEGAL_AREAS = [
  "Personen- en Familierecht",
  "Arbeidsrecht",
  "Strafrecht",
  "Bestuursrecht",
  "Belastingrecht",
  "Socialezekerheidsrecht",
  "Ambtenarenrecht",
  "Ondernemingsrecht",
  "Insolventierecht",
  "Goederenrecht",
  "Verbintenissenrecht",
  "Huurrecht",
  "Intellectueel-eigendomsrecht",
  "Mededingingsrecht",
  "Europees recht",
  "Internationaal publiekrecht",
  "Vreemdelingenrecht",
  "Gezondheidsrecht",
  "Omgevingsrecht",
  "Milieurecht",
  "Energierecht",
  "Telecommunicatierecht",
  "Vervoersrecht",
  "Verzekeringsrecht",
  "Financieel recht",
  "Bankrecht",
  "Effectenrecht",
  "Pensioenrecht",
  "Civiel procesrecht",
  "Strafprocesrecht",
  "Bestuurs procesrecht",
  "Arbitragerecht",
  "Mediarecht",
  "Sportrecht",
  "Agrarisch recht",
  "Internationaal privaatrecht",
];

interface LegalAreasSelectProps {
  value: string[];
  onChange: (areas: string[]) => void;
  disabled?: boolean;
}

export function LegalAreasSelect({ value, onChange, disabled }: LegalAreasSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return DUTCH_LEGAL_AREAS;
    return DUTCH_LEGAL_AREAS.filter((a) => a.toLowerCase().includes(q));
  }, [query]);

  const handleSelect = (area: string) => {
    if (value.includes(area)) {
      onChange(value.filter((a) => a !== area));
    } else {
      onChange([...value, area]);
    }
  };

  const handleRemove = (area: string) => {
    onChange(value.filter((a) => a !== area));
  };

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between"
            disabled={disabled}
          >
            {value.length === 0
              ? "Select legal areas..."
              : `${value.length} area${value.length > 1 ? 's' : ''} selected`}
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-(--radix-popover-trigger-width) p-2" align="start">
          <Input
            placeholder="Search legal areas..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="mb-2 h-8"
          />
          <div className="max-h-64 overflow-auto rounded-md border border-border/60">
            {filtered.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">No legal area found.</p>
            ) : (
              filtered.map((area) => (
                <button
                  key={area}
                  type="button"
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted"
                  onClick={() => handleSelect(area)}
                >
                  <Check
                    className={cn(
                      'h-4 w-4 shrink-0',
                      value.includes(area) ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className="truncate">{area}</span>
                </button>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>

      {/* Selected areas */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {value.map((area) => (
            <Badge
              key={area}
              variant="secondary"
              className="flex items-center gap-1"
            >
              {area}
              {!disabled && (
                <button
                  onClick={() => handleRemove(area)}
                  className="ml-1 hover:bg-muted rounded-full"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

export { DUTCH_LEGAL_AREAS };

