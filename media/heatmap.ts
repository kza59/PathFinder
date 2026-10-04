type RGB = readonly [number, number, number];

export interface HeatPalette {
  low: RGB;
  high: RGB;
}

export interface HeatRange {
  min: number;
  max: number;
}

/** Muted fills keep the existing theme's label color readable. */
export function heatPalette(foreground: string): HeatPalette {
  const hex = foreground.match(/^#([\da-f]{6}|[\da-f]{3})$/i)?.[1];
  const rgb = hex
    ? (hex.length === 3 ? [...hex].map(channel => channel + channel).join('') : hex)
      .match(/../g)!.map(channel => parseInt(channel, 16))
    : foreground.match(/[\d.]+/g)?.slice(0, 3).map(Number);
  const brightness = rgb?.length === 3
    ? (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255
    : 1;
  return brightness > 0.5
    ? { low: [104, 88, 20], high: [139, 48, 48] }
    : { low: [242, 224, 142], high: [242, 184, 184] };
}

/** Linear interpolation in RGB, shared by node fills and the legend gradient. */
export function heatColor(position: number, palette: HeatPalette): string {
  const t = Math.max(0, Math.min(1, position));
  const channels = palette.low.map((low, index) => Math.round(low + (palette.high[index] - low) * t));
  return `rgb(${channels.join(',')})`;
}

export function heatPosition(count: number, range: HeatRange): number {
  return range.min === range.max ? 0.5 : (count - range.min) / (range.max - range.min);
}
