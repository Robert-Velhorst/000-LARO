import { Component, ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error Boundary Component
 * 
 * Catches JavaScript errors in child components and displays a fallback UI
 * instead of crashing the entire application.
 */
export class PageErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error("Error caught by boundary:", error, errorInfo);
    if (import.meta.env.PROD) {
      void window.electronAPI?.reportRendererError({
        message: error.message,
        stack: error.stack,
        componentStack: errorInfo.componentStack,
        route: window.location.pathname,
      }).catch((reportError) => console.error("Could not persist renderer error report:", reportError));
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  handleGoHome = () => {
    window.location.href = "/";
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-4 bg-background">
          <Card className="max-w-2xl w-full border-destructive/50 bg-card/50 backdrop-blur-sm">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="p-3 rounded-full bg-destructive/10">
                  <AlertTriangle className="w-8 h-8 text-destructive" />
                </div>
                <CardTitle className="text-2xl">
                  {this.props.fallbackTitle || "Something went wrong"}
                </CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <p className="text-muted-foreground">
                  We encountered an unexpected error. This has been logged and we'll look into it.
                </p>
                {import.meta.env.DEV && this.state.error && (
                  <details className="mt-4 p-4 bg-muted/50 rounded-lg">
                    <summary className="cursor-pointer font-medium text-sm">
                      Error Details (Development Only)
                    </summary>
                    <pre className="mt-2 text-xs overflow-auto max-h-64">
                      {this.state.error.message}
                      {"\n\n"}
                      {this.state.error.stack}
                    </pre>
                  </details>
                )}
              </div>

              <div className="flex gap-3">
                <Button
                  onClick={this.handleReset}
                  variant="default"
                  className="bg-orange-500 hover:bg-orange-600"
                >
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Try Again
                </Button>
                <Button
                  onClick={this.handleGoHome}
                  variant="outline"
                >
                  <Home className="w-4 h-4 mr-2" />
                  Go to Dashboard
                </Button>
              </div>

              <div className="pt-4 border-t border-border/50">
                <p className="text-sm text-muted-foreground">
                  If this problem persists, please contact support with the error details above.
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }

    return this.props.children;
  }
}

