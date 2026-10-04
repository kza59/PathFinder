// Explore needs a browser animation scheduler; advance it explicitly in headless tests.
let frames: FrameRequestCallback[] = [];
Object.defineProperty(globalThis, 'window', {
  value: {
    requestAnimationFrame: (callback: FrameRequestCallback) => frames.push(callback),
  },
  configurable: true,
});

export function advanceAnimationFrames(count = 1): void {
  for (let frame = 0; frame < count; frame++) {
    const callbacks = frames;
    frames = [];
    callbacks.forEach(callback => callback(frame * 16));
  }
}

export function pendingAnimationFrames(): number {
  return frames.length;
}
