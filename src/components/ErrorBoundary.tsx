import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import i18n from '@/i18n';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen flex items-center justify-center bg-background text-foreground">
          <div className="text-center max-w-md px-6">
            <AlertTriangle size={48} className="mx-auto mb-4 text-yellow-500" />
            <h1 className="text-lg font-semibold mb-2">{i18n.t('error.boundaryTitle')}</h1>
            <p className="text-sm text-muted-foreground mb-4">
              {this.state.error?.message || i18n.t('error.boundaryFallback')}
            </p>
            <button
              className="px-4 py-2 text-sm rounded bg-theme-accent text-white hover:opacity-90 transition-opacity"
              onClick={this.handleReload}
            >
              {i18n.t('error.reload')}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
