/**
 * Lawyer Profile Card Component
 * 
 * Display detailed lawyer information with stats and specializations
 */

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { 
  MapPin, 
  Mail, 
  Phone, 
  Globe, 
  Star, 
  Clock, 
  CheckCircle2,
  TrendingUp,
  Award
} from "lucide-react";

interface LawyerProfileCardProps {
  lawyer: {
    id: string;
    name: string;
    email?: string;
    phone?: string;
    website?: string;
    address?: string;
    city?: string;
    postalCode?: string;
    specializations?: string[];
    responseRate?: number;
    acceptanceRate?: number;
    avgResponseTime?: number;
    totalCasesHandled?: number;
    yearsOfExperience?: number;
    rating?: number;
  };
  onContact?: (lawyerId: string) => void;
  onViewProfile?: (lawyerId: string) => void;
}

export default function LawyerProfileCard({ lawyer, onContact, onViewProfile }: LawyerProfileCardProps) {
  const formatResponseTime = (hours?: number) => {
    if (!hours) return "N/A";
    if (hours < 24) return `${Math.round(hours)}h`;
    return `${Math.round(hours / 24)}d`;
  };

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm hover:border-orange-500/50 transition-all">
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <h3 className="text-xl font-semibold mb-1">{lawyer.name}</h3>
            {lawyer.city && (
              <div className="flex items-center gap-1 text-sm text-muted-foreground">
                <MapPin className="w-3 h-3" />
                <span>{lawyer.city}</span>
              </div>
            )}
          </div>
          {lawyer.rating && (
            <div className="flex items-center gap-1 bg-yellow-500/10 px-2 py-1 rounded-lg">
              <Star className="w-4 h-4 text-yellow-500 fill-yellow-500" />
              <span className="text-sm font-medium">{lawyer.rating.toFixed(1)}</span>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Specializations */}
        {lawyer.specializations && lawyer.specializations.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {lawyer.specializations.slice(0, 3).map((spec) => (
              <Badge key={spec} variant="secondary" className="text-xs">
                {spec}
              </Badge>
            ))}
            {lawyer.specializations.length > 3 && (
              <Badge variant="outline" className="text-xs">
                +{lawyer.specializations.length - 3} more
              </Badge>
            )}
          </div>
        )}

        {/* Stats Grid */}
        <div className="grid grid-cols-2 gap-3">
          {/* Response Rate */}
          {lawyer.responseRate !== undefined && (
            <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/20">
              <div className="flex items-center gap-2 mb-1">
                <CheckCircle2 className="w-4 h-4 text-green-500" />
                <span className="text-xs text-muted-foreground">Response Rate</span>
              </div>
              <p className="text-lg font-bold text-green-400">
                {Math.round(lawyer.responseRate * 100)}%
              </p>
            </div>
          )}

          {/* Acceptance Rate */}
          {lawyer.acceptanceRate !== undefined && (
            <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <div className="flex items-center gap-2 mb-1">
                <TrendingUp className="w-4 h-4 text-blue-500" />
                <span className="text-xs text-muted-foreground">Accept Rate</span>
              </div>
              <p className="text-lg font-bold text-blue-400">
                {Math.round(lawyer.acceptanceRate * 100)}%
              </p>
            </div>
          )}

          {/* Response Time */}
          {lawyer.avgResponseTime !== undefined && (
            <div className="p-3 rounded-lg bg-purple-500/10 border border-purple-500/20">
              <div className="flex items-center gap-2 mb-1">
                <Clock className="w-4 h-4 text-purple-500" />
                <span className="text-xs text-muted-foreground">Avg Response</span>
              </div>
              <p className="text-lg font-bold text-purple-400">
                {formatResponseTime(lawyer.avgResponseTime)}
              </p>
            </div>
          )}

          {/* Experience */}
          {lawyer.yearsOfExperience !== undefined && (
            <div className="p-3 rounded-lg bg-orange-500/10 border border-orange-500/20">
              <div className="flex items-center gap-2 mb-1">
                <Award className="w-4 h-4 text-orange-500" />
                <span className="text-xs text-muted-foreground">Experience</span>
              </div>
              <p className="text-lg font-bold text-orange-400">
                {lawyer.yearsOfExperience}y
              </p>
            </div>
          )}
        </div>

        {/* Contact Info */}
        <div className="space-y-2 pt-2 border-t border-border/50">
          {lawyer.email && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Mail className="w-4 h-4" />
              <span className="truncate">{lawyer.email}</span>
            </div>
          )}
          {lawyer.phone && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Phone className="w-4 h-4" />
              <span>{lawyer.phone}</span>
            </div>
          )}
          {lawyer.website && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Globe className="w-4 h-4" />
              <a 
                href={lawyer.website} 
                target="_blank" 
                rel="noopener noreferrer"
                className="truncate hover:text-orange-500 transition-colors"
              >
                {lawyer.website.replace(/^https?:\/\//, '')}
              </a>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2 pt-2">
          <Button
            onClick={() => onViewProfile?.(lawyer.id)}
            variant="outline"
            className="flex-1"
          >
            View Profile
          </Button>
          <Button
            onClick={() => onContact?.(lawyer.id)}
            className="flex-1 bg-orange-500 hover:bg-orange-600"
          >
            Contact
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

