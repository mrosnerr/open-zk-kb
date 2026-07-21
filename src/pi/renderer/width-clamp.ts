/**
 * WidthClamp — wraps a component to ensure lines fit within the viewport.
 * Vendored from mpp-renderer — will be replaced when mpp-renderer is published.
 */

import type { Component } from '@earendil-works/pi-tui';
import { truncateToWidth } from '@earendil-works/pi-tui';

export class WidthClamp implements Component {
  constructor(private child: Component) {}

  render(width: number): string[] {
    return this.child
      .render(width)
      .map((line) => truncateToWidth(line, width, ''));
  }

  invalidate(): void {
    this.child.invalidate?.();
  }
}
