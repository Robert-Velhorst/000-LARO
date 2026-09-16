import React, { Component, ReactNode } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
  title?: string;
  description?: string;
}

interface State {
  hasError: boolean;
  error?: Error;
}

/**
 * Error boundary for catching React errors in component tree
 * Use to wrap critical sections that shouldn't crash the entire app
 */
export class ErrorBoundarySection extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught an error:", error, errorInfo);
    
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <Card className="border-destructive">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              <CardTitle>{this.props.title || "Something went wrong"}</CardTitle>
            </div>
            <CardDescription>
              {this.props.description || "An error occurred while rendering this section."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {this.state.error && (
              <div className="mb-4 p-3 rounded-lg bg-muted text-sm font-mono text-muted-foreground">
                {this.state.error.message}
              </div>
            )}
            <Button onClick={this.handleReset} variant="outline" size="sm">
              <RefreshCw className="h-4 w-4 mr-2" />
              Try Again
            </Button>
          </CardContent>
        </Card>
      );
    }

    return this.props.children;
  }
}

/**
 * Functional wrapper for error boundary
 */
export function withErrorBoundary<P extends object>(
  Component: React.ComponentType<P>,
  errorBoundaryProps?: Omit<Props, "children">
) {
  return function WithErrorBoundaryWrapper(props: P) {
    return (
      <ErrorBoundarySection {...errorBoundaryProps}>
        <Component {...props} />
      </ErrorBoundarySection>
    );
  };
}

