import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Plus,
  Upload,
  Search,
  Mail,
  FileText,
  Calendar,
  Users,
  BarChart
} from "lucide-react";
import { useLocation } from "wouter";

export default function QuickActionsMenu() {
  const [, setLocation] = useLocation();

  const actions = [
    {
      icon: Plus,
      label: "New Case",
      description: "Start a new legal case",
      onClick: () => setLocation("/cases?action=new"),
      variant: "default" as const
    },
    {
      icon: Upload,
      label: "Upload Evidence",
      description: "Add documents to a case",
      onClick: () => setLocation("/evidence"),
      variant: "outline" as const
    },
    {
      icon: Search,
      label: "Find Lawyer",
      description: "Search for legal representation",
      onClick: () => setLocation("/lawyers"),
      variant: "outline" as const
    },
    {
      icon: Mail,
      label: "Send Email",
      description: "Contact lawyers or parties",
      onClick: () => setLocation("/email"),
      variant: "outline" as const
    },
    {
      icon: FileText,
      label: "View Documents",
      description: "Browse all evidence",
      onClick: () => setLocation("/evidence"),
      variant: "outline" as const
    },
    {
      icon: Calendar,
      label: "Deadlines",
      description: "Check upcoming deadlines",
      onClick: () => setLocation("/cases"),
      variant: "outline" as const
    },
    {
      icon: Users,
      label: "Contacts",
      description: "Manage lawyer contacts",
      onClick: () => setLocation("/lawyers"),
      variant: "outline" as const
    },
    {
      icon: BarChart,
      label: "Reports",
      description: "View analytics and insights",
      onClick: () => setLocation("/reports"),
      variant: "outline" as const
    }
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Quick Actions</CardTitle>
        <CardDescription>Common tasks and shortcuts</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {actions.map((action, index) => {
            const Icon = action.icon;
            return (
              <Button
                key={index}
                variant={action.variant}
                className="h-auto flex-col gap-2 p-4"
                onClick={action.onClick}
              >
                <Icon className="h-6 w-6" />
                <div className="text-center">
                  <p className="font-medium text-sm">{action.label}</p>
                  <p className="text-xs text-muted-foreground mt-1 hidden md:block">
                    {action.description}
                  </p>
                </div>
              </Button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

