import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, CheckCircle, Clock, XCircle } from "lucide-react";

interface OutreachData {
  legalArea: string;
  totalContacted: number;
  interested: number;
  declined: number;
  noResponse: number;
  averageResponseTime?: number; // in hours
}

interface MultiDisciplineOutreachChartProps {
  data: OutreachData[];
  caseId?: string;
}

/**
 * Multi-Discipline Outreach Visualization
 * 
 * Shows outreach progress across different legal areas for cases that span
 * multiple disciplines (e.g., divorce + employment law + housing law).
 * 
 * Helps users understand:
 * - Which legal areas have good lawyer engagement
 * - Which areas need more outreach
 * - Response patterns across disciplines
 */
export default function MultiDisciplineOutreachChart({ data }: MultiDisciplineOutreachChartProps) {
  if (!data || data.length === 0) {
    return (
      <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="w-5 h-5 text-purple-500" />
            Multi-Discipline Outreach
          </CardTitle>
          <CardDescription>
            No outreach data available yet
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const getTotalResponses = (item: OutreachData) => item.interested + item.declined;
  const getResponseRate = (item: OutreachData) => {
    if (item.totalContacted === 0) return 0;
    return Math.round((getTotalResponses(item) / item.totalContacted) * 100);
  };
  const getInterestRate = (item: OutreachData) => {
    const responses = getTotalResponses(item);
    if (responses === 0) return 0;
    return Math.round((item.interested / responses) * 100);
  };

  return (
    <Card className="border-border/50 bg-card/50 backdrop-blur-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="w-5 h-5 text-purple-500" />
          Multi-Discipline Outreach Progress
        </CardTitle>
        <CardDescription>
          Lawyer engagement across different legal areas for your case
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.map((item, index) => {
          const responseRate = getResponseRate(item);
          const interestRate = getInterestRate(item);
          const totalResponses = getTotalResponses(item);

          return (
            <div
              key={index}
              className="p-4 rounded-lg border border-border/50 bg-background/50 space-y-3"
            >
              {/* Header */}
              <div className="flex items-center justify-between">
                <div>
                  <h4 className="font-semibold text-foreground">{item.legalArea}</h4>
                  <p className="text-sm text-muted-foreground">
                    {item.totalContacted} lawyer{item.totalContacted !== 1 ? "s" : ""} contacted
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge
                    variant={responseRate >= 50 ? "default" : "secondary"}
                    className={responseRate >= 50 ? "bg-green-500" : ""}
                  >
                    {responseRate}% response rate
                  </Badge>
                  {interestRate > 0 && (
                    <Badge variant="outline" className="border-blue-500 text-blue-500">
                      {interestRate}% interested
                    </Badge>
                  )}
                </div>
              </div>

              {/* Progress Bar */}
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Outreach Progress</span>
                </div>
                <div className="h-8 bg-muted rounded-lg overflow-hidden flex">
                  {/* Interested */}
                  {item.interested > 0 && (
                    <div
                      className="bg-green-500 flex items-center justify-center text-white text-xs font-medium transition-all"
                      style={{
                        width: `${(item.interested / item.totalContacted) * 100}%`,
                      }}
                      title={`${item.interested} interested`}
                    >
                      {item.interested > 0 && (
                        <span className="px-2">{item.interested}</span>
                      )}
                    </div>
                  )}

                  {/* Declined */}
                  {item.declined > 0 && (
                    <div
                      className="bg-red-500 flex items-center justify-center text-white text-xs font-medium transition-all"
                      style={{
                        width: `${(item.declined / item.totalContacted) * 100}%`,
                      }}
                      title={`${item.declined} declined`}
                    >
                      {item.declined > 0 && (
                        <span className="px-2">{item.declined}</span>
                      )}
                    </div>
                  )}

                  {/* No Response */}
                  {item.noResponse > 0 && (
                    <div
                      className="bg-yellow-500/50 flex items-center justify-center text-white text-xs font-medium transition-all"
                      style={{
                        width: `${(item.noResponse / item.totalContacted) * 100}%`,
                      }}
                      title={`${item.noResponse} no response`}
                    >
                      {item.noResponse > 0 && (
                        <span className="px-2">{item.noResponse}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Stats Grid */}
              <div className="grid grid-cols-3 gap-3">
                <div className="flex items-center gap-2 p-2 rounded bg-green-500/10">
                  <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
                  <div>
                    <p className="text-xs text-muted-foreground">Interested</p>
                    <p className="font-semibold text-green-500">{item.interested}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 p-2 rounded bg-red-500/10">
                  <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                  <div>
                    <p className="text-xs text-muted-foreground">Declined</p>
                    <p className="font-semibold text-red-500">{item.declined}</p>
                  </div>
                </div>

                <div className="flex items-center gap-2 p-2 rounded bg-yellow-500/10">
                  <Clock className="w-4 h-4 text-yellow-500 flex-shrink-0" />
                  <div>
                    <p className="text-xs text-muted-foreground">Pending</p>
                    <p className="font-semibold text-yellow-500">{item.noResponse}</p>
                  </div>
                </div>
              </div>

              {/* Average Response Time */}
              {item.averageResponseTime && totalResponses > 0 && (
                <div className="pt-2 border-t border-border/50">
                  <p className="text-xs text-muted-foreground">
                    Average response time:{" "}
                    <span className="font-medium text-foreground">
                      {item.averageResponseTime < 24
                        ? `${Math.round(item.averageResponseTime)}h`
                        : `${Math.round(item.averageResponseTime / 24)}d`}
                    </span>
                  </p>
                </div>
              )}
            </div>
          );
        })}

        {/* Overall Summary */}
        {data.length > 1 && (
          <div className="pt-4 border-t border-border/50">
            <div className="grid grid-cols-3 gap-4">
              <div className="text-center">
                <p className="text-2xl font-bold text-foreground">
                  {data.reduce((sum, item) => sum + item.totalContacted, 0)}
                </p>
                <p className="text-xs text-muted-foreground">Total Contacted</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-green-500">
                  {data.reduce((sum, item) => sum + item.interested, 0)}
                </p>
                <p className="text-xs text-muted-foreground">Total Interested</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-blue-500">
                  {Math.round(
                    (data.reduce((sum, item) => sum + getTotalResponses(item), 0) /
                      data.reduce((sum, item) => sum + item.totalContacted, 0)) *
                      100
                  )}
                  %
                </p>
                <p className="text-xs text-muted-foreground">Overall Response Rate</p>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

