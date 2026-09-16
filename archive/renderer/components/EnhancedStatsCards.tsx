import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { 
  Briefcase, 
  Users, 
  FileText, 
  TrendingUp, 
  Clock,
  CheckCircle2,
  Mail,
  AlertCircle
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export default function EnhancedStatsCards() {
  const { data: stats, isLoading } = trpc.dashboard.enhancedStats.useQuery();

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {[...Array(4)].map((_, i) => (
          <Card key={i}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-4 rounded-full" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16 mb-2" />
              <Skeleton className="h-3 w-32" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (!stats) {
    return null;
  }

  const statCards = [
    {
      title: "Total Cases",
      value: stats.totalCases,
      description: `${stats.activeCases} active, ${stats.closedCases} closed`,
      icon: Briefcase,
      trend: stats.totalCases > 0 ? "+100%" : "0%",
      trendUp: true
    },
    {
      title: "Lawyers Contacted",
      value: stats.lawyersContacted,
      description: `${stats.lawyersResponded} responded (${stats.responseRate}%)`,
      icon: Users,
      trend: `${stats.responseRate}%`,
      trendUp: stats.responseRate > 50
    },
    {
      title: "Documents Uploaded",
      value: stats.documentsUploaded,
      description: "Evidence and supporting files",
      icon: FileText,
      trend: stats.documentsUploaded > 0 ? "+100%" : "0%",
      trendUp: true
    },
    {
      title: "Acceptance Rate",
      value: `${stats.acceptanceRate}%`,
      description: `${stats.lawyersAccepted} lawyers accepted cases`,
      icon: CheckCircle2,
      trend: `${stats.acceptanceRate}%`,
      trendUp: stats.acceptanceRate > 30
    }
  ];

  const additionalStats = [
    {
      title: "Avg Response Time",
      value: stats.avgResponseTime,
      description: "Average time for lawyer response",
      icon: Clock,
      color: "text-blue-500"
    },
    {
      title: "Pending Responses",
      value: stats.lawyersContacted - stats.lawyersResponded,
      description: "Awaiting lawyer responses",
      icon: Mail,
      color: "text-orange-500"
    },
    {
      title: "Active Deadlines",
      value: stats.activeDeadlines || 0,
      description: "Upcoming case deadlines",
      icon: AlertCircle,
      color: "text-red-500"
    },
    {
      title: "Success Rate",
      value: `${Math.round((stats.closedCases / (stats.totalCases || 1)) * 100)}%`,
      description: "Cases successfully closed",
      icon: TrendingUp,
      color: "text-green-500"
    }
  ];

  return (
    <div className="space-y-4">
      {/* Primary Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {statCards.map((stat, index) => {
          const Icon = stat.icon;
          return (
            <Card key={index}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  {stat.title}
                </CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stat.value}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {stat.description}
                </p>
                <div className={`flex items-center text-xs mt-2 ${stat.trendUp ? 'text-green-600' : 'text-red-600'}`}>
                  <TrendingUp className={`h-3 w-3 mr-1 ${!stat.trendUp && 'rotate-180'}`} />
                  {stat.trend}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Secondary Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {additionalStats.map((stat, index) => {
          const Icon = stat.icon;
          return (
            <Card key={index} className="bg-card/50">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  {stat.title}
                </CardTitle>
                <Icon className={`h-4 w-4 ${stat.color}`} />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stat.value}</div>
                <p className="text-xs text-muted-foreground mt-1">
                  {stat.description}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

