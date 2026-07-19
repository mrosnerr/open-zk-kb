import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function demoPresentation(pi: ExtensionAPI): void {
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return;

    ctx.ui.setFooter(() => ({
      render(): string[] {
        return [];
      },
      invalidate(): void {},
    }));
  });
}
