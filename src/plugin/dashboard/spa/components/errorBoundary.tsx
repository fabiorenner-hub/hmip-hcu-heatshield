/**
 * Minimal error boundary so a single broken card does not take the
 * whole SPA down. Preact lets us catch render-time errors via
 * `componentDidCatch`; we hold the error in state and render a
 * graceful fallback on subsequent renders.
 */

import { Component, Fragment, h, type ComponentChildren, type JSX } from 'preact';

import { t } from '../i18n.js';

export interface ErrorBoundaryProps {
  children: ComponentChildren;
  fallback?: (error: Error) => ComponentChildren;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { error: null };

  public override componentDidCatch(error: Error): void {
    // Surface the failure to the dev tools so it is debuggable
    // without taking the whole SPA down.

    console.error('[heatshield-spa] component error:', error);
    this.setState({ error });
  }

  public override render(props: ErrorBoundaryProps, state: ErrorBoundaryState): JSX.Element {
    if (state.error !== null) {
      const fallback = props.fallback;
      if (fallback) {
        return <Fragment>{fallback(state.error)}</Fragment>;
      }
      return (
        <div class="error-boundary" role="alert">
          <strong>{t('Etwas ist schief gelaufen.', 'Something went wrong.')}</strong>
          <pre>{state.error.message}</pre>
        </div>
      );
    }
    return <Fragment>{props.children}</Fragment>;
  }
}
