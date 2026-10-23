'use client';

import { ChevronDown, Info, Maximize2, Monitor, Moon, Smartphone, SlidersHorizontal, Sun } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Segmented } from '@/components/ui/segmented';
import { cn } from '@/lib/utils';
import { usePreviewScale, type Appearance, type Device } from './preview-context';
import './previews.css';

export type { Appearance, Device } from './preview-context';

/** Widths of the simulated surface. They are presets for a comfortable review, not claims about a platform’s exact size. */
export const SIM_WIDTH: Record<'feed' | 'article', Record<Device, number>> = {
  feed: { desktop: 600, mobile: 390 },
  article: { desktop: 720, mobile: 390 },
};

export interface FrameControl {
  label: string;
  value: string;
  options: { value: string; label: ReactNode; title?: string }[];
  onChange(value: string): void;
}

const PLACEHOLDER_NOTE = 'The name, picture and buttons drawn here are placeholders and inert. Nothing in this preview is sent.';

/** The Desktop and Phone choice, and the platform in light or dark. */
function DeviceAndAppearance({ name, device, onDevice, appearance, onAppearance }: { name: string; device: Device; onDevice(device: Device): void; appearance: Appearance; onAppearance(appearance: Appearance): void }) {
  return (
    <>
      <Segmented
        label="Device"
        value={device}
        onChange={onDevice}
        options={[
          { value: 'desktop', label: <><Monitor aria-hidden className="size-4" /><span className="sr-only sm:not-sr-only">Desktop</span></>, title: 'Desktop width' },
          { value: 'mobile', label: <><Smartphone aria-hidden className="size-4" /><span className="sr-only sm:not-sr-only">Mobile</span></>, title: 'Phone width' },
        ]}
      />
      <Segmented
        label={`${name} appearance`}
        value={appearance}
        onChange={onAppearance}
        options={[
          { value: 'light', label: <><Sun aria-hidden className="size-4" /><span className="sr-only">Light</span></>, title: 'Show the platform in light' },
          { value: 'dark', label: <><Moon aria-hidden className="size-4" /><span className="sr-only">Dark</span></>, title: 'Show the platform in dark' },
        ]}
      />
    </>
  );
}

/**
 * Every preview sits in this frame. The label "Approximate preview" is outside the simulated surface and always
 * visible, because the simulation shows the adapted payload in the platform’s typography and never a pixel copy of
 * its interface. Name, avatar and any buttons drawn inside are placeholders or inert decoration.
 *
 * In `compact` form (the publishing screen) the controls are one slim bar: the checks on the left, the label, one View
 * panel that holds every choice about how the preview is drawn, and Expand. Otherwise they sit in a row.
 */
export function PreviewFrame({
  name,
  device,
  onDevice,
  appearance,
  onAppearance,
  controls = [],
  footer,
  note,
  onExpand,
  compact = false,
  leading,
  below,
  menu,
  children,
  className,
}: {
  name: string;
  device: Device;
  onDevice(device: Device): void;
  appearance: Appearance;
  onAppearance(appearance: Appearance): void;
  controls?: FrameControl[];
  footer?: ReactNode;
  note?: string;
  /** When given, an Expand control opens this preview large. It receives the button so focus can return to it. */
  onExpand?: (button: HTMLButtonElement) => void;
  compact?: boolean;
  /** Compact only: what sits at the start of the bar (the checks). */
  leading?: ReactNode;
  /** Compact only: what opens between the bar and the preview (the checks list). */
  below?: ReactNode;
  /** Compact only: the page's own sections of the View panel. */
  menu?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const expand = onExpand ? (
    <Button type="button" variant="outline" aria-haspopup="dialog" aria-label={`Expand ${name} preview`} title="Open this preview large" onClick={(e) => onExpand(e.currentTarget)}>
      <Maximize2 aria-hidden />
      <span className="sr-only @xl:not-sr-only">Expand</span>
    </Button>
  ) : null;

  if (compact) {
    return (
      <section aria-label={`${name} preview`} className={cn('@container min-w-0 rounded-xl border bg-muted/50', className)}>
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2">
          {leading}
          <span className="ml-auto text-sm text-muted-foreground" title={`Layout may differ on ${name}.`}>
            Approximate preview
          </span>
          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" aria-label={`View options for the ${name} preview`}>
                <SlidersHorizontal aria-hidden />
                View
                <ChevronDown aria-hidden className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="grid gap-4">
              {controls.map((control) => (
                <ViewSection key={control.label} title={control.label}>
                  <Segmented label={control.label} value={control.value} options={control.options} onChange={control.onChange} />
                </ViewSection>
              ))}
              <ViewSection title="Preview as">
                <DeviceAndAppearance name={name} device={device} onDevice={onDevice} appearance={appearance} onAppearance={onAppearance} />
              </ViewSection>
              {menu}
              <p className="flex items-start gap-1.5 border-t pt-3 text-xs leading-5 text-muted-foreground">
                <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                {note ?? PLACEHOLDER_NOTE}
              </p>
            </PopoverContent>
          </Popover>
          {expand}
        </header>
        {below}
        <div className="overflow-x-auto px-2 py-4 sm:px-4">{children}</div>
        {footer ? <footer className="space-y-1 border-t px-3 py-2.5 text-xs leading-5 text-muted-foreground">{footer}</footer> : null}
      </section>
    );
  }

  return (
    <section aria-label={`${name} preview`} className={cn('min-w-0 rounded-xl border bg-muted/50', className)}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-3 py-2.5">
        <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
          <Info aria-hidden className="size-4 shrink-0 text-info" />
          <span>Approximate preview</span>
          <span className="truncate font-normal text-muted-foreground">Layout may differ on {name}.</span>
        </p>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {controls.map((control) => (
            <Segmented key={control.label} label={control.label} value={control.value} options={control.options} onChange={control.onChange} />
          ))}
          <DeviceAndAppearance name={name} device={device} onDevice={onDevice} appearance={appearance} onAppearance={onAppearance} />
          {onExpand ? (
            <Button type="button" size="sm" variant="outline" aria-haspopup="dialog" aria-label={`Expand ${name} preview`} onClick={(e) => onExpand(e.currentTarget)}>
              <Maximize2 aria-hidden />
              Expand
            </Button>
          ) : null}
        </div>
      </header>
      <div className="overflow-x-auto px-2 py-4 sm:px-4">{children}</div>
      <footer className="space-y-1 border-t px-3 py-2.5 text-xs leading-5 text-muted-foreground">
        {footer}
        <p>{note ?? PLACEHOLDER_NOTE}</p>
      </footer>
    </section>
  );
}

/** One titled group of choices inside the View panel. */
export function ViewSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <p className="mono-label text-muted-foreground">{title}</p>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** The simulated surface itself: carries the appearance, device and skin as data attributes for the stylesheet. */
export function Sim({ device, appearance, skin, kind, accent, children, label }: { device: Device; appearance: Appearance; skin: string; kind: 'feed' | 'article'; accent?: string; children: ReactNode; label: string }) {
  // The size choice scales the whole surface (CSS zoom); its width limit is a percentage, which zoom resolves in its own units, so it still fits its column.
  const scale = usePreviewScale();
  return (
    <div
      className="sim mx-auto"
      data-device={device}
      data-appearance={appearance}
      data-skin={skin}
      role="group"
      aria-label={label}
      style={{ width: SIM_WIDTH[kind][device], ...(scale !== 1 ? { zoom: scale } : {}), ...(accent ? { ['--sim-accent' as string]: accent } : {}) }}
    >
      {children}
    </div>
  );
}
