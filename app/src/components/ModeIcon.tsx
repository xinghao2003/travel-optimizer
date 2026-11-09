import { Bus, BusFront, Car, CarTaxiFront, Footprints, Plane, TrainFront, TrainFrontTunnel, TramFront, type LucideIcon } from "lucide-react";
import { modeLabel } from "../lib/present";

const icons: Record<string, LucideIcon> = { flight: Plane, rail: TrainFront, bus: Bus, coach: BusFront, subway: TrainFrontTunnel, tram: TramFront, car: Car, taxi: CarTaxiFront, walk: Footprints, foot: Footprints };

/** The icon of a transport mode, with the sr-only text "by {mode}" (C11). Other modes show their name. */
export function ModeIcon({ mode, size = 14 }: { mode: string; size?: number }) {
  const Icon = icons[mode];
  const name = modeLabel(mode === "foot" ? "walk" : mode).toLowerCase();
  return Icon ? <><Icon size={size} className="p-mode-icon" aria-hidden="true" /><span className="sr-only">by {name}</span></> : <span className="p-mode-text">by {name}</span>;
}
