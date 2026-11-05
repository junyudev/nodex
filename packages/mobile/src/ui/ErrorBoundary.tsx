import { Component, type ReactNode } from "react";
import { View } from "react-native";

import { Button, EmptyState } from "./primitives";

/**
 * The last resort: what cannot be shown says so and can try again, rather than closing the app.
 * Trying again starts from the top, which also leaves a screen that keeps failing behind.
 */
export class ErrorBoundary extends Component<
  { readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <View className="flex-1 bg-surface px-6 pb-16">
        <EmptyState
          icon="warning"
          title="Something went wrong"
          detail="Nodex couldn't show this. If it keeps happening, restart your phone and open Nodex again."
        />
        <Button label="Try again" onPress={() => this.setState({ failed: false })} />
      </View>
    );
  }
}
